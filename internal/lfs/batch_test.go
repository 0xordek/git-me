package lfs

import (
	"context"
	"testing"

	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

func TestHandleBatchUpload(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	req := &BatchRequest{
		Operation: OperationUpload,
		Objects: []BatchObject{
			{OID: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", Size: 1024},
		},
	}

	resp, err := HandleBatch(ctx, req, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}

	if len(resp.Objects) != 1 {
		t.Fatalf("len(Objects) = %d, want 1", len(resp.Objects))
	}

	obj := resp.Objects[0]
	if obj.OID != req.Objects[0].OID {
		t.Errorf("OID = %q", obj.OID)
	}
	if obj.Actions["upload"].Href == "" {
		t.Error("upload action href is empty")
	}
	if obj.Actions["upload"].Href != "/objects/"+obj.OID {
		t.Errorf("upload href = %q, want /objects/<oid>", obj.Actions["upload"].Href)
	}
	if obj.Error != nil {
		t.Errorf("unexpected error: %v", obj.Error)
	}
}

func TestHandleBatchDownload(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	oid := "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2a"

	metaStore.Put(ctx, &metadata.ObjectMeta{
		OID:      oid,
		Size:     512,
		Uploaded: true,
	})

	req := &BatchRequest{
		Operation: OperationDownload,
		Objects:   []BatchObject{{OID: oid, Size: 512}},
	}

	resp, err := HandleBatch(ctx, req, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}

	obj := resp.Objects[0]
	if obj.Actions["download"].Href == "" {
		t.Error("download action href is empty")
	}
	if obj.Actions["download"].Href != "/objects/"+oid {
		t.Errorf("download href = %q, want /objects/<oid>", obj.Actions["download"].Href)
	}
}

func TestHandleBatchDownloadNotFound(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	req := &BatchRequest{
		Operation: OperationDownload,
		Objects:   []BatchObject{{OID: "nonexistent-oid-nx1234567890abcdef1234567890abcdef1234567890ab", Size: 1}},
	}

	resp, err := HandleBatch(ctx, req, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}

	obj := resp.Objects[0]
	if obj.Error == nil {
		t.Fatal("expected error for nonexistent object")
	}
	if obj.Error.Code != 404 {
		t.Errorf("Error.Code = %d, want 404", obj.Error.Code)
	}
}

func TestHandleBatchMixedObjects(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	existingOID := "mixed-existing-1234567890abcdef1234567890abcdef1234567890ab12"
	metaStore.Put(ctx, &metadata.ObjectMeta{OID: existingOID, Size: 100, Uploaded: true})

	req := &BatchRequest{
		Operation: OperationDownload,
		Objects: []BatchObject{
			{OID: existingOID, Size: 100},
			{OID: "mixed-missing1-1234567890abcdef1234567890abcdef1234567890ab12", Size: 200},
		},
	}

	resp, err := HandleBatch(ctx, req, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}

	if len(resp.Objects) != 2 {
		t.Fatalf("len(Objects) = %d, want 2", len(resp.Objects))
	}
	if resp.Objects[0].Error != nil {
		t.Errorf("Objects[0] unexpected error: %v", resp.Objects[0].Error)
	}
	if resp.Objects[1].Error == nil {
		t.Fatal("Objects[1] expected error for missing object")
	}
}

func TestHandleBatchUnknownOperation(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	req := &BatchRequest{
		Operation: "verify",
		Objects:   []BatchObject{{OID: "oid123", Size: 1}},
	}

	_, err := HandleBatch(ctx, req, objStore, metaStore)
	if err == nil {
		t.Fatal("expected error for unknown operation")
	}
}

func TestHandleBatchEmptyObjects(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	req := &BatchRequest{
		Operation: OperationUpload,
		Objects:   []BatchObject{},
	}

	resp, err := HandleBatch(ctx, req, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}
	if len(resp.Objects) != 0 {
		t.Errorf("len(Objects) = %d, want 0", len(resp.Objects))
	}
}
