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

func TestFullUploadDownloadFlow(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	objects := []struct {
		oid     string
		content []byte
	}{
		{"c2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", []byte("Hello from object 1")},
		{"d2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", bytes.Repeat([]byte("B"), 1024)},
		{"e2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", []byte("")},
	}

	t.Run("upload all objects", func(t *testing.T) {
		for _, obj := range objects {
			err := HandleUpload(ctx, obj.oid, bytes.NewReader(obj.content), objStore, metaStore)
			if err != nil {
				t.Fatalf("HandleUpload(%q) error = %v", obj.oid, err)
			}
		}
	})

	t.Run("batch download returns all objects", func(t *testing.T) {
		batchObjs := make([]BatchObject, len(objects))
		for i, obj := range objects {
			batchObjs[i] = BatchObject{OID: obj.oid, Size: int64(len(obj.content))}
		}

		req := &BatchRequest{
			Operation: OperationDownload,
			Objects:   batchObjs,
		}

		resp, err := HandleBatch(ctx, req, objStore, metaStore)
		if err != nil {
			t.Fatalf("HandleBatch() error = %v", err)
		}

		if len(resp.Objects) != len(objects) {
			t.Fatalf("len(Objects) = %d, want %d", len(resp.Objects), len(objects))
		}

		for i, obj := range resp.Objects {
			if obj.Error != nil {
				t.Errorf("Objects[%d] unexpected error: %v", i, obj.Error)
			}
			if obj.Actions["download"].Href == "" {
				t.Errorf("Objects[%d] missing download href", i)
			}
		}
	})

	t.Run("download and verify content", func(t *testing.T) {
		for _, expected := range objects {
			reader, size, err := HandleDownload(ctx, expected.oid, objStore, metaStore)
			if err != nil {
				t.Fatalf("HandleDownload(%q) error = %v", expected.oid, err)
			}
			defer reader.Close()

			if size != int64(len(expected.content)) {
				t.Errorf("size = %d, want %d", size, len(expected.content))
			}

			got, _ := io.ReadAll(reader)
			if !bytes.Equal(got, expected.content) {
				t.Errorf("content mismatch for %q: got %q, want %q", expected.oid, string(got), string(expected.content))
			}
		}
	})
}

func TestBatchUploadThenIndividualUploads(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	objects := []BatchObject{
		{OID: "f2b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", Size: 512},
		{OID: "a3b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", Size: 256},
	}

	batchReq := &BatchRequest{
		Operation: OperationUpload,
		Objects:   objects,
	}

	resp, err := HandleBatch(ctx, batchReq, objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleBatch() error = %v", err)
	}

	for i, obj := range resp.Objects {
		if obj.Actions["upload"].Href != "/objects/"+objects[i].OID {
			t.Errorf("upload href mismatch: %q", obj.Actions["upload"].Href)
		}
	}

	contents := [][]byte{
		[]byte("batch flow content for object 1"),
		[]byte("batch flow content for object 2 - different size"),
	}

	for i, obj := range objects {
		err := HandleUpload(ctx, obj.OID, bytes.NewReader(contents[i]), objStore, metaStore)
		if err != nil {
			t.Fatalf("HandleUpload(%q) error = %v", obj.OID, err)
		}
	}

	for i, obj := range objects {
		reader, _, err := HandleDownload(ctx, obj.OID, objStore, metaStore)
		if err != nil {
			t.Fatalf("HandleDownload(%q) error = %v", obj.OID, err)
		}
		defer reader.Close()

		got, _ := io.ReadAll(reader)
		if !bytes.Equal(got, contents[i]) {
			t.Errorf("content mismatch for %q", obj.OID)
		}
	}
}

func TestEdgeCaseInvalidOIDInURL(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	_, _, err := HandleDownload(ctx, "", objStore, metaStore)
	if err == nil {
		t.Fatal("expected error for empty OID")
	}
}

func TestEdgeCaseUploadEmptyBodyPipe(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	err := HandleUpload(ctx, "b3b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", strings.NewReader(""), objStore, metaStore)
	if err != nil {
		t.Fatalf("HandleUpload() with empty reader error = %v", err)
	}

	meta, err := metaStore.Get(ctx, "b3b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2")
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if meta.Size != 0 {
		t.Errorf("meta.Size = %d, want 0 for empty upload", meta.Size)
	}
}

func TestUploadDoesNotAffectOtherObjects(t *testing.T) {
	ctx := context.Background()
	objStore := storage.NewInMemoryStore()
	metaStore := metadata.NewInMemoryStore()

	HandleUpload(ctx, "c3b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", bytes.NewReader([]byte("first")), objStore, metaStore)
	HandleUpload(ctx, "d3b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", bytes.NewReader([]byte("second")), objStore, metaStore)

	r1, _, _ := HandleDownload(ctx, "c3b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2", objStore, metaStore)
	defer r1.Close()
	content, _ := io.ReadAll(r1)
	if string(content) != "first" {
		t.Errorf("object 1 content = %q, want %q", string(content), "first")
	}
}
