package lfs

import (
	"bytes"
	"context"
	"io"
	"testing"

	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

func TestHandleDownload(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "download-oid-1234567890abcdef1234567890abcdef1234567890abcdef1234"
	content := []byte("downloadable content goes here")

	metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: int64(len(content)), Uploaded: true})
	objStore.Put(ctx, oid, bytes.NewReader(content))

	reader, size, err := HandleDownload(ctx, oid, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleDownload() error = %v", err)
	}
	defer reader.Close()

	if size != int64(len(content)) {
		t.Errorf("size = %d, want %d", size, len(content))
	}

	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}

	if !bytes.Equal(got, content) {
		t.Errorf("content = %q, want %q", string(got), string(content))
	}
}

func TestHandleDownloadNotUploaded(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "not-uploaded-1234567890abcdef1234567890abcdef1234567890abcdef1234"
	metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: 100, Uploaded: false})

	_, _, err := HandleDownload(ctx, oid, objStore, metaStore)
	if err == nil {
		t.Fatal("expected error for not-yet-uploaded object")
	}
}

func TestHandleDownloadNotFound(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	_, _, err := HandleDownload(ctx, "nonexistent-dl-1234567890abcdef1234567890abcdef1234567890ab12", objStore, metaStore)
	if err == nil {
		t.Fatal("expected error for nonexistent object")
	}
}

func TestHandleDownloadMissingInStore(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "missing-in-store-1234567890abcdef1234567890abcdef1234567890abcdef"
	metaStore.Put(ctx, &metadata.ObjectMeta{OID: oid, Size: 42, Uploaded: true})

	_, _, err := HandleDownload(ctx, oid, objStore, metaStore)
	if err == nil {
		t.Fatal("expected error when metadata exists but object does not")
	}
}
