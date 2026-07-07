package lfs

import "testing"

const validOID = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

func TestValidateOID(t *testing.T) {
	cases := []struct {
		name    string
		oid     string
		wantErr bool
	}{
		{name: "valid lowercase hex", oid: validOID, wantErr: false},
		{name: "valid uppercase hex", oid: "A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2", wantErr: false},
		{name: "empty", oid: "", wantErr: true},
		{name: "short", oid: "abc123", wantErr: true},
		{name: "non hex", oid: "g1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", wantErr: true},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateOID(tt.oid)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateOID() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestSelectTransfer(t *testing.T) {
	cases := []struct {
		name      string
		transfers []string
		want      string
		wantErr   bool
	}{
		{name: "missing defaults basic", transfers: nil, want: "basic"},
		{name: "empty defaults basic", transfers: []string{}, want: "basic"},
		{name: "basic offered", transfers: []string{"basic"}, want: "basic"},
		{name: "basic second", transfers: []string{"lfs-standalone-file", "basic"}, want: "basic"},
		{name: "unsupported", transfers: []string{"ssh"}, wantErr: true},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			got, err := SelectTransfer(tt.transfers)
			if (err != nil) != tt.wantErr {
				t.Fatalf("SelectTransfer() error = %v, wantErr %v", err, tt.wantErr)
			}
			if got != tt.want {
				t.Fatalf("SelectTransfer() = %q, want %q", got, tt.want)
			}
		})
	}
}

func TestValidateBatchRequest(t *testing.T) {
	cases := []struct {
		name    string
		req     *BatchRequest
		wantErr bool
	}{
		{
			name: "valid upload",
			req:  &BatchRequest{Operation: OperationUpload, Transfers: []string{"basic"}, Objects: []BatchObject{{OID: validOID, Size: 1}}},
		},
		{
			name:    "negative size",
			req:     &BatchRequest{Operation: OperationUpload, Objects: []BatchObject{{OID: validOID, Size: -1}}},
			wantErr: true,
		},
		{
			name:    "invalid oid",
			req:     &BatchRequest{Operation: OperationUpload, Objects: []BatchObject{{OID: "abc", Size: 1}}},
			wantErr: true,
		},
		{
			name:    "unsupported transfer",
			req:     &BatchRequest{Operation: OperationUpload, Transfers: []string{"ssh"}, Objects: []BatchObject{{OID: validOID, Size: 1}}},
			wantErr: true,
		},
	}

	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateBatchRequest(tt.req)
			if (err != nil) != tt.wantErr {
				t.Fatalf("ValidateBatchRequest() error = %v, wantErr %v", err, tt.wantErr)
			}
		})
	}
}

func TestIsLFSContentType(t *testing.T) {
	cases := []struct {
		contentType string
		want        bool
	}{
		{contentType: ContentType, want: true},
		{contentType: ContentType + "; charset=utf-8", want: true},
		{contentType: "application/json", want: false},
		{contentType: "", want: false},
	}

	for _, tt := range cases {
		got := IsLFSContentType(tt.contentType)
		if got != tt.want {
			t.Fatalf("IsLFSContentType(%q) = %v, want %v", tt.contentType, got, tt.want)
		}
	}
}
