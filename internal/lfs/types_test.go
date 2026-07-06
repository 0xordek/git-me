package lfs

import (
	"encoding/json"
	"testing"
)

func TestBatchRequestUnmarshal(t *testing.T) {
	body := `{
		"operation": "upload",
		"transfers": ["basic"],
		"objects": [
			{"oid": "abc123", "size": 1048576},
			{"oid": "def456", "size": 2048}
		]
	}`

	var req BatchRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatalf("unmarshal error = %v", err)
	}

	if req.Operation != "upload" {
		t.Errorf("Operation = %q, want %q", req.Operation, "upload")
	}
	if len(req.Objects) != 2 {
		t.Fatalf("len(Objects) = %d, want 2", len(req.Objects))
	}
	if req.Objects[0].OID != "abc123" {
		t.Errorf("Objects[0].OID = %q, want %q", req.Objects[0].OID, "abc123")
	}
	if req.Objects[1].Size != 2048 {
		t.Errorf("Objects[1].Size = %d, want 2048", req.Objects[1].Size)
	}
}

func TestBatchRequestUnmarshalDownload(t *testing.T) {
	body := `{"operation": "download", "transfers": ["basic"], "objects": [{"oid": "abc123", "size": 1024}]}`

	var req BatchRequest
	json.Unmarshal([]byte(body), &req)

	if req.Operation != "download" {
		t.Errorf("Operation = %q, want %q", req.Operation, "download")
	}
}

func TestBatchResponseMarshal(t *testing.T) {
	resp := BatchResponse{
		Transfer: "basic",
		Objects: []TransferObject{
			{
				OID:  "abc123",
				Size: 1024,
				Actions: map[string]ObjectAction{
					"upload": {
						Href: "https://example.com/objects/abc123",
						Header: map[string]string{
							"Content-Type": "application/octet-stream",
						},
					},
				},
			},
		},
	}

	data, err := json.Marshal(resp)
	if err != nil {
		t.Fatalf("marshal error = %v", err)
	}

	var parsed BatchResponse
	json.Unmarshal(data, &parsed)

	if parsed.Transfer != "basic" {
		t.Errorf("Transfer = %q, want %q", parsed.Transfer, "basic")
	}
	if len(parsed.Objects) != 1 {
		t.Fatalf("len(Objects) = %d, want 1", len(parsed.Objects))
	}
	if parsed.Objects[0].Actions["upload"].Href != "https://example.com/objects/abc123" {
		t.Errorf("upload href = %q", parsed.Objects[0].Actions["upload"].Href)
	}
}

func TestBatchResponseWithError(t *testing.T) {
	resp := BatchResponse{
		Transfer: "basic",
		Objects: []TransferObject{
			{
				OID:   "bad-oid",
				Size:  0,
				Error: &ObjectError{Code: 422, Message: "invalid OID format"},
			},
		},
	}

	data, _ := json.Marshal(resp)

	var parsed BatchResponse
	json.Unmarshal(data, &parsed)

	if parsed.Objects[0].Error == nil {
		t.Fatal("expected error object, got nil")
	}
	if parsed.Objects[0].Error.Code != 422 {
		t.Errorf("Error.Code = %d, want 422", parsed.Objects[0].Error.Code)
	}
}

func TestLfsErrorResponseMarshal(t *testing.T) {
	err := &LfsError{Message: "Not authenticated", DocumentationURL: "https://git-lfs.com/docs"}

	data, _ := json.Marshal(err)

	var parsed LfsError
	json.Unmarshal(data, &parsed)

	if parsed.Message != "Not authenticated" {
		t.Errorf("Message = %q", parsed.Message)
	}
}

func TestBatchRequestInvalidJSON(t *testing.T) {
	var req BatchRequest
	err := json.Unmarshal([]byte(`{invalid}`), &req)
	if err == nil {
		t.Fatal("expected unmarshal error for invalid JSON")
	}
}

func TestBatchRequestMissingOperation(t *testing.T) {
	body := `{"transfers": ["basic"], "objects": [{"oid": "abc", "size": 1}]}`
	var req BatchRequest
	json.Unmarshal([]byte(body), &req)

	if req.Operation != "" {
		t.Errorf("Operation should be empty when missing, got %q", req.Operation)
	}
}
