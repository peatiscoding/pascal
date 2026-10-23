package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
)

// MCP JSON-RPC types

type jsonrpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      any             `json:"id,omitempty"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type jsonrpcResponse struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id,omitempty"`
	Result  any    `json:"result,omitempty"`
	Error   *rpcError `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

// MCP protocol types

type serverInfo struct {
	Name    string `json:"name"`
	Version string `json:"version"`
}

type initResult struct {
	ProtocolVersion string     `json:"protocolVersion"`
	Capabilities    any        `json:"capabilities"`
	ServerInfo      serverInfo `json:"serverInfo"`
}

type toolDef struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	InputSchema any    `json:"inputSchema"`
}

type toolsListResult struct {
	Tools []toolDef `json:"tools"`
}

type callToolParams struct {
	Name      string         `json:"name"`
	Arguments map[string]any `json:"arguments"`
}

type toolResult struct {
	Content []contentBlock `json:"content"`
	IsError bool           `json:"isError,omitempty"`
}

type contentBlock struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

var apiBase string

func init() {
	apiBase = os.Getenv("PASCAL_API_URL")
	if apiBase == "" {
		apiBase = "http://localhost:7600"
	}
}

func main() {
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 1024*1024)

	for scanner.Scan() {
		line := scanner.Bytes()
		if len(line) == 0 {
			continue
		}

		var req jsonrpcRequest
		if err := json.Unmarshal(line, &req); err != nil {
			continue
		}

		resp := handle(req)
		if resp != nil {
			out, _ := json.Marshal(resp)
			fmt.Fprintf(os.Stdout, "%s\n", out)
		}
	}
}

func handle(req jsonrpcRequest) *jsonrpcResponse {
	switch req.Method {
	case "initialize":
		return ok(req.ID, initResult{
			ProtocolVersion: "2024-11-05",
			Capabilities:    map[string]any{"tools": map[string]any{}},
			ServerInfo:      serverInfo{Name: "pascal", Version: "1.0.0"},
		})

	case "notifications/initialized":
		return nil // no response for notifications

	case "tools/list":
		return ok(req.ID, toolsListResult{Tools: toolDefs()})

	case "tools/call":
		var params callToolParams
		if err := json.Unmarshal(req.Params, &params); err != nil {
			return errResp(req.ID, -32602, "invalid params: "+err.Error())
		}
		result, isErr := callTool(params.Name, params.Arguments)
		return ok(req.ID, toolResult{
			Content: []contentBlock{{Type: "text", Text: result}},
			IsError: isErr,
		})

	case "ping":
		return ok(req.ID, map[string]any{})

	default:
		return errResp(req.ID, -32601, "method not found: "+req.Method)
	}
}

func ok(id any, result any) *jsonrpcResponse {
	return &jsonrpcResponse{JSONRPC: "2.0", ID: id, Result: result}
}

func errResp(id any, code int, msg string) *jsonrpcResponse {
	return &jsonrpcResponse{JSONRPC: "2.0", ID: id, Error: &rpcError{Code: code, Message: msg}}
}

// --- Tool definitions ---

func toolDefs() []toolDef {
	return []toolDef{
		{
			Name:        "create_record",
			Description: "Create a new record in PASCAL. Records are the core data entity for logging events, expenses, tasks, etc.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"title":  map[string]any{"type": "string", "description": "Record title (short summary)"},
					"detail": map[string]any{"type": "string", "description": "Optional longer description"},
					"scope":  map[string]any{"type": "string", "description": "Scope path (e.g. 'Work|ProjectX'). Use list_scopes to see available scopes."},
					"status": map[string]any{"type": "integer", "description": "Status code (0=paused, 1=todo, 2=doing, 3=done). Omit to use recipe's default status, or 1 if no recipe."},
					"recipe": map[string]any{"type": "string", "description": "Optional recipe usecase key to associate with this record"},
					"tags":   map[string]any{"type": "array", "items": map[string]any{"type": "string"}, "description": "Tag keys to attach. Use list_tags to see available tags."},
					"values": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"k": map[string]any{"type": "string", "description": "Value key (e.g. 'THB', 'TOKEN')"},
								"v": map[string]any{"type": "number", "description": "Numeric value"},
							},
							"required": []string{"k", "v"},
						},
						"description": "Numeric values to attach. Use list_master_values to see available value types.",
					},
				},
				"required": []string{"title", "scope"},
			},
		},
		{
			Name:        "list_records",
			Description: "List records with optional filters.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"scope":  map[string]any{"type": "string", "description": "Filter by scope prefix"},
					"tag":    map[string]any{"type": "string", "description": "Filter by tag"},
					"status": map[string]any{"type": "integer", "description": "Filter by status (0=open, 1=done, 2=cancelled)"},
					"from":   map[string]any{"type": "string", "description": "Start date (ISO 8601)"},
					"to":     map[string]any{"type": "string", "description": "End date (ISO 8601)"},
					"limit":  map[string]any{"type": "integer", "description": "Max records to return (default 100)"},
				},
			},
		},
		{
			Name:        "list_recipes",
			Description: "List all recipes. Recipes are templates that define what values and scopes a record type expects.",
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "list_scopes",
			Description: "List all scopes. Scopes define the organizational hierarchy (e.g. Work, Personal, Work|ProjectX).",
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "list_tags",
			Description: "List all tags. Tags label records for filtering. Scoped tags are exclusive (one per scope per record).",
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "list_master_values",
			Description: "List all master value types (e.g. THB, TOKEN, calories). These define what numeric values can be attached to records.",
			InputSchema: map[string]any{"type": "object", "properties": map[string]any{}},
		},
		{
			Name:        "create_scope",
			Description: "Create a new scope for organizing records.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"name":      map[string]any{"type": "string", "description": "Scope name"},
					"parent_id": map[string]any{"type": "integer", "description": "Parent scope ID (omit for root scope). Use list_scopes to find parent IDs."},
				},
				"required": []string{"name"},
			},
		},
		{
			Name:        "create_tag",
			Description: "Create a new tag for labeling records.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"tag":         map[string]any{"type": "string", "description": "Tag key (alphanumeric and dashes only)"},
					"scope_id":    map[string]any{"type": "integer", "description": "Optional scope ID — tags sharing a scope are exclusive (one per record)"},
					"description": map[string]any{"type": "string", "description": "Optional description"},
				},
				"required": []string{"tag"},
			},
		},
		{
			Name:        "create_master_value",
			Description: "Create a new master value type for numeric tracking.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"key":         map[string]any{"type": "string", "description": "Value key (e.g. 'THB', 'TOKEN', 'KCAL')"},
					"description": map[string]any{"type": "string", "description": "What this value type represents"},
				},
				"required": []string{"key", "description"},
			},
		},
		{
			Name:        "ingest_text",
			Description: "Submit unstructured text to PASCAL's ingestion queue. Ollama processes it into a structured record.",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"text":   map[string]any{"type": "string", "description": "Unstructured text to process"},
					"source": map[string]any{"type": "string", "description": "Source identifier (default: 'mcp')"},
				},
				"required": []string{"text"},
			},
		},
	}
}

// --- Tool execution ---

func callTool(name string, args map[string]any) (string, bool) {
	switch name {
	case "create_record":
		return doCreateRecord(args)
	case "list_records":
		return doListRecords(args)
	case "list_recipes":
		return doGet("/api/recipes")
	case "list_scopes":
		return doGet("/api/scopes")
	case "list_tags":
		return doGet("/api/tags")
	case "list_master_values":
		return doGet("/api/master-values")
	case "create_scope":
		return doCreateScope(args)
	case "create_tag":
		return doCreateTag(args)
	case "create_master_value":
		return doCreateMasterValue(args)
	case "ingest_text":
		return doIngestText(args)
	default:
		return "unknown tool: " + name, true
	}
}

func doCreateRecord(args map[string]any) (string, bool) {
	body := map[string]any{
		"tl": args["title"],
		"sc": args["scope"],
	}
	if v, ok := args["status"]; ok {
		body["st"] = v
	}
	if v, ok := args["detail"]; ok {
		body["dt"] = v
	}
	if v, ok := args["recipe"]; ok {
		body["r"] = v
	}
	if v, ok := args["tags"]; ok {
		body["tags"] = v
	}
	if v, ok := args["values"]; ok {
		body["values"] = v
	}
	return doPost("/api/records", body)
}

func doListRecords(args map[string]any) (string, bool) {
	var params []string
	for _, k := range []string{"scope", "tag", "from", "to"} {
		if v, ok := args[k]; ok {
			params = append(params, fmt.Sprintf("%s=%v", k, v))
		}
	}
	if v, ok := args["status"]; ok {
		params = append(params, fmt.Sprintf("st=%v", v))
	}
	if v, ok := args["limit"]; ok {
		params = append(params, fmt.Sprintf("limit=%v", v))
	}
	path := "/api/records"
	if len(params) > 0 {
		path += "?" + strings.Join(params, "&")
	}
	return doGet(path)
}

func doCreateScope(args map[string]any) (string, bool) {
	body := map[string]any{"name": args["name"]}
	if v, ok := args["parent_id"]; ok {
		body["parent_id"] = v
	}
	return doPost("/api/scopes", body)
}

func doCreateTag(args map[string]any) (string, bool) {
	body := map[string]any{"t": args["tag"]}
	if v, ok := args["scope_id"]; ok {
		body["s"] = v
	}
	if v, ok := args["description"]; ok {
		body["d"] = v
	}
	return doPost("/api/tags", body)
}

func doCreateMasterValue(args map[string]any) (string, bool) {
	return doPost("/api/master-values", map[string]any{
		"k": args["key"],
		"d": args["description"],
	})
}

func doIngestText(args map[string]any) (string, bool) {
	body := map[string]any{"text": args["text"]}
	if v, ok := args["source"]; ok {
		body["source"] = v
	} else {
		body["source"] = "mcp"
	}
	return doPost("/api/ingest/text", body)
}

// --- HTTP helpers ---

func doGet(path string) (string, bool) {
	resp, err := http.Get(apiBase + path)
	if err != nil {
		return "API error: " + err.Error(), true
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Sprintf("API %d: %s", resp.StatusCode, string(data)), true
	}
	// Pretty-print JSON
	var buf bytes.Buffer
	if json.Indent(&buf, data, "", "  ") == nil {
		return buf.String(), false
	}
	return string(data), false
}

func doPost(path string, body map[string]any) (string, bool) {
	data, _ := json.Marshal(body)
	resp, err := http.Post(apiBase+path, "application/json", bytes.NewReader(data))
	if err != nil {
		return "API error: " + err.Error(), true
	}
	defer resp.Body.Close()
	out, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		return fmt.Sprintf("API %d: %s", resp.StatusCode, string(out)), true
	}
	var buf bytes.Buffer
	if json.Indent(&buf, out, "", "  ") == nil {
		return buf.String(), false
	}
	return string(out), false
}

func intArg(args map[string]any, key string, def int) int {
	v, ok := args[key]
	if !ok {
		return def
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return def
	}
}
