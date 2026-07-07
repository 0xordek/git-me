package lfs

import (
	"context"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

type existsErrorStore struct {
	err error
}

func (s existsErrorStore) Put(ctx context.Context, oid string, reader io.Reader) error {
	return nil
}

func (s existsErrorStore) Get(ctx context.Context, oid string) (io.ReadCloser, error) {
	return nil, s.err
}

func (s existsErrorStore) Exists(ctx context.Context, oid string) (bool, error) {
	return false, s.err
}

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

	oid := "b1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

	metaStore.Put(ctx, &metadata.ObjectMeta{
		OID:      oid,
		Size:     512,
		Uploaded: true,
	})
	if err := objStore.Put(ctx, oid, strings.NewReader("download data")); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

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
		Objects:   []BatchObject{{OID: "f1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", Size: 1}},
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

	existingOID := "d1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	metaStore.Put(ctx, &metadata.ObjectMeta{OID: existingOID, Size: 100, Uploaded: true})
	if err := objStore.Put(ctx, existingOID, strings.NewReader("mixed data")); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	req := &BatchRequest{
		Operation: OperationDownload,
		Objects: []BatchObject{
			{OID: existingOID, Size: 100},
			{OID: "e1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", Size: 200},
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

func TestHandleBatchDownloadMetadataExistsObjectMissing(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()
	oid := "c1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

	if err := metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: 12, Uploaded: true}); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	resp, err := HandleBatch(ctx, &BatchRequest{Operation: OperationDownload, Objects: []BatchObject{{OID: oid, Size: 12}}}, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}

	obj := resp.Objects[0]
	if obj.Error == nil {
		t.Fatal("expected object error when metadata exists but object is missing")
	}
	if obj.Error.Code != 404 {
		t.Fatalf("Error.Code = %d, want 404", obj.Error.Code)
	}
	if obj.Actions != nil {
		t.Fatalf("Actions = %v, want nil", obj.Actions)
	}
}

func TestHandleBatchDownloadPropagatesObjectExistsError(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	oid := "c2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	existsErr := errors.New("exists unavailable")

	if err := metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: 12, Uploaded: true}); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	_, err := HandleBatch(ctx, &BatchRequest{Operation: OperationDownload, Objects: []BatchObject{{OID: oid, Size: 12}}}, existsErrorStore{err: existsErr}, metaStore)
	if err == nil {
		t.Fatal("expected HandleBatch to return store.Exists error")
	}
	if !errors.Is(err, existsErr) {
		t.Fatalf("HandleBatch() error = %v, want %v", err, existsErr)
	}
}

func TestHandleBatchRejectsUnsupportedTransfer(t *testing.T) {
	ctx := context.Background()
	metaStore := metadata.NewInMemoryStore()
	objStore := storage.NewInMemoryStore()

	_, err := HandleBatch(ctx, &BatchRequest{
		Operation: OperationUpload,
		Transfers: []string{"ssh"},
		Objects:   []BatchObject{{OID: validOID, Size: 1}},
	}, objStore, metaStore)
	if err == nil {
		t.Fatal("expected unsupported transfer error")
	}
}
