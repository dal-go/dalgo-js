// Command parity runs the DTQL parity cases through the Go reference engine
// (github.com/dal-go/dalgo, pinned in go.mod) and writes the expected results
// that test/parity.test.ts compares the TypeScript engine against.
//
// It is run by hand through tools/parity/regenerate.sh; CI never needs Go.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"

	"github.com/dal-go/dalgo/dal"
	"github.com/dal-go/dalgo/dtql"
	"github.com/dal-go/dalgo/recordset"
	"github.com/dal-go/record"
)

// caseDef is one parity case. Exactly one of Query (a JSON DTQL document),
// YAML (inline text) or YAMLFile (relative to the parity directory) is set.
// YAMLReplace and YAMLAppend derive variants of a checked-in saved query.
// The remaining fields are read by the TypeScript test only.
type caseDef struct {
	Name        string          `json:"name"`
	Query       json.RawMessage `json:"query"`
	YAML        string          `json:"yaml"`
	YAMLFile    string          `json:"yamlFile"`
	YAMLReplace [][2]string     `json:"yamlReplace"`
	YAMLAppend  string          `json:"yamlAppend"`
}

type caseFile struct {
	Cases []caseDef `json:"cases"`
}

type dataset struct {
	Tables map[string]map[string][]map[string]any `json:"tables"`
}

type memDB struct{ tables map[string][]map[string]any }

func (db memDB) ExecuteQueryToRecordsReader(_ context.Context, query dal.Query) (dal.RecordsReader, error) {
	q := query.(dal.StructuredQuery)
	name := q.From().Base().Name()
	rows := db.tables[name]
	out := make([]record.Record, len(rows))
	for i, row := range rows {
		data := map[string]any{}
		for k, v := range row {
			data[k] = v
		}
		out[i] = record.NewRecordWithData(record.NewKeyWithID(name, fmt.Sprint(i)), data)
	}
	return dal.NewRecordsReader(out), nil
}

func (memDB) ExecuteQueryToRecordsetReader(context.Context, dal.Query, ...recordset.Option) (dal.RecordsetReader, error) {
	return nil, fmt.Errorf("recordsets unsupported")
}

func main() {
	root := flag.String("root", "../../test/parity", "parity directory (dataset.json, cases/*.json)")
	out := flag.String("out", "", "expected results file (default <root>/expected.json)")
	commit := flag.String("commit", "", "dalgo commit recorded in the output (the commit go.mod is pinned to)")
	flag.Parse()
	if *out == "" {
		*out = filepath.Join(*root, "expected.json")
	}

	var data dataset
	mustReadJSON(filepath.Join(*root, "dataset.json"), &data)
	files, err := filepath.Glob(filepath.Join(*root, "cases", "*.json"))
	if err != nil || len(files) == 0 {
		fatalf("no case files under %s/cases", *root)
	}
	sort.Strings(files)

	results := map[string]any{}
	for _, file := range files {
		var cf caseFile
		mustReadJSON(file, &cf)
		for _, c := range cf.Cases {
			if _, dup := results[c.Name]; dup {
				fatalf("duplicate case name %q", c.Name)
			}
			results[c.Name] = run(c, *root, data)
		}
	}

	doc := map[string]any{
		"dalgo":   map[string]any{"module": "github.com/dal-go/dalgo", "version": dalgoVersion(), "commit": *commit},
		"results": results,
	}
	encoded, err := json.MarshalIndent(doc, "", " ")
	if err != nil {
		fatalf("encode: %v", err)
	}
	if err := os.WriteFile(*out, append(encoded, '\n'), 0o644); err != nil {
		fatalf("write: %v", err)
	}
	fmt.Fprintf(os.Stderr, "wrote %d results to %s\n", len(results), *out)
}

func dalgoVersion() string {
	info, ok := debug.ReadBuildInfo()
	if !ok {
		return ""
	}
	for _, dep := range info.Deps {
		if dep.Path == "github.com/dal-go/dalgo" {
			return dep.Version
		}
	}
	return ""
}

func document(c caseDef, root string) ([]byte, error) {
	switch {
	case c.YAMLFile != "":
		raw, err := os.ReadFile(filepath.Join(root, c.YAMLFile))
		if err != nil {
			return nil, err
		}
		text := string(raw)
		for _, pair := range c.YAMLReplace {
			if !strings.Contains(text, pair[0]) {
				return nil, fmt.Errorf("yamlReplace: %q not found in %s", pair[0], c.YAMLFile)
			}
			text = strings.Replace(text, pair[0], pair[1], 1)
		}
		return []byte(text + c.YAMLAppend), nil
	case c.YAML != "":
		return []byte(c.YAML), nil
	default:
		return c.Query, nil
	}
}

// run reports {rows} on success or {error, phase} where phase is "parse"
// (Deserialize), "plan" (federated planning) or "read" (execution).
func run(c caseDef, root string, data dataset) (out any) {
	defer func() {
		if r := recover(); r != nil {
			out = map[string]any{"error": fmt.Sprint("PANIC: ", r), "phase": "panic"}
		}
	}()
	doc, err := document(c, root)
	if err != nil {
		fatalf("case %q: %v", c.Name, err)
	}
	query, err := dtql.Deserialize(doc)
	if err != nil {
		return map[string]any{"error": err.Error(), "phase": "parse"}
	}
	reader, err := dal.ExecuteFederatedQuery(context.Background(), query, func(_ context.Context, database string) (dal.QueryExecutor, error) {
		tables, ok := data.Tables[database]
		if !ok {
			return nil, fmt.Errorf("unknown database %q", database)
		}
		return memDB{tables: tables}, nil
	})
	if err != nil {
		return map[string]any{"error": err.Error(), "phase": "plan"}
	}
	records, err := dal.ReadAllToRecords(context.Background(), reader)
	if err != nil {
		return map[string]any{"error": err.Error(), "phase": "read"}
	}
	rows := make([]any, 0, len(records))
	for _, rec := range records {
		rows = append(rows, rec.Data())
	}
	return map[string]any{"rows": rows}
}

func mustReadJSON(path string, into any) {
	raw, err := os.ReadFile(path)
	if err != nil {
		fatalf("%v", err)
	}
	if err := json.Unmarshal(raw, into); err != nil {
		fatalf("%s: %v", path, err)
	}
}

func fatalf(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "parity: "+format+"\n", args...)
	os.Exit(1)
}
