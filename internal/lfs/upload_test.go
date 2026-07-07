package lfs

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"

	"github.com/0xordek/git-me/internal/metadata"
	"github.com/0xordek/git-me/internal/storage"
)

func TestHandleUpload(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "d1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	content := []byte("test file content for upload")

	err := HandleUpload(ctx, oid, bytes.NewReader(content), objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleUpload() error = %v", err)
	}

	exists, err := objStore.Exists(ctx, oid)
	if err != nil {
		t.Fatalf("Exists() error = %v", err)
	}
	if !exists {
		t.Fatal("object should exist after upload")
	}

	meta, err := metaStore.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if meta.Size != int64(len(content)) {
		t.Errorf("meta.Size = %d, want %d", meta.Size, len(content))
	}
	if !meta.Uploaded {
		t.Error("meta.Uploaded should be true after upload")
	}
	if meta.OID != oid {
		t.Errorf("meta.OID = %q, want %q", meta.OID, oid)
	}
}

func TestHandleUploadCorrectContent(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "e1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	content := []byte("exact content verification test data")

	HandleUpload(ctx, oid, bytes.NewReader(content), objStore, metaStore)

	reader, err := objStore.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	defer reader.Close()

	got, _ := io.ReadAll(reader)
	if !bytes.Equal(got, content) {
		t.Errorf("stored content mismatch: got %q, want %q", string(got), string(content))
	}
}

func TestHandleUploadEmptyContent(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "f1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	err := HandleUpload(ctx, oid, strings.NewReader(""), objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleUpload() error = %v", err)
	}

	meta, err := metaStore.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if meta.Size != 0 {
		t.Errorf("meta.Size = %d, want 0 for empty content", meta.Size)
	}
}

func TestHandleUploadOverwrite(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "a2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	first := []byte("first version")
	second := []byte("second version - completely different data")

	HandleUpload(ctx, oid, bytes.NewReader(first), objStore, metaStore)
	HandleUpload(ctx, oid, bytes.NewReader(second), objStore, metaStore)

	reader, _ := objStore.Get(ctx, oid)
	defer reader.Close()
	got, _ := io.ReadAll(reader)

	if !bytes.Equal(got, second) {
		t.Errorf("content after overwrite = %q, want %q", string(got), string(second))
	}

	meta, _ := metaStore.Get(ctx, oid)
	if meta.Size != int64(len(second)) {
		t.Errorf("meta.Size after overwrite = %d, want %d", meta.Size, len(second))
	}
}

func TestHandleUploadLargeContent(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	oid := "b2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"
	largeData := bytes.Repeat([]byte("A"), 5*1024*1024) // 5 MB

	err := HandleUpload(ctx, oid, bytes.NewReader(largeData), objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleUpload() large content error = %v", err)
	}

	meta, err := metaStore.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if meta.Size != int64(len(largeData)) {
		t.Errorf("meta.Size = %d, want %d", meta.Size, len(largeData))
	}
}
