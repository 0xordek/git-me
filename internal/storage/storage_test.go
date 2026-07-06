package storage

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
)

func TestInMemoryStorePutAndGet(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	oid := "abc123def456abc123def456abc123def456abc123def456abc123def456abc1"
	content := []byte("Hello, Git LFS!")

	if err := store.Put(ctx, oid, bytes.NewReader(content)); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	reader, err := store.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	defer reader.Close()

	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("ReadAll() error = %v", err)
	}

	if !bytes.Equal(got, content) {
		t.Errorf("content = %q, want %q", string(got), string(content))
	}
}

func TestInMemoryStoreExists(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	oid := "exists-oid-1234567890abcdef1234567890abcdef1234567890abcdef1234"

	exists, err := store.Exists(ctx, oid)
	if err != nil {
		t.Fatalf("Exists() error = %v", err)
	}
	if exists {
		t.Error("Exists() = true before Put, want false")
	}

	store.Put(ctx, oid, strings.NewReader("data"))

	exists, err = store.Exists(ctx, oid)
	if err != nil {
		t.Fatalf("Exists() error = %v", err)
	}
	if !exists {
		t.Error("Exists() = false after Put, want true")
	}
}

func TestInMemoryStoreGetNotFound(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	_, err := store.Get(ctx, "nonexistent")
	if err != ErrNotFound {
		t.Errorf("Get() error = %v, want ErrNotFound", err)
	}
}

func TestInMemoryStoreConcurrentPutGet(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	done := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		go func(n int) {
			oid := "concurrent-oid-" + string(rune('0'+n))
			store.Put(ctx, oid, strings.NewReader("data"))
			store.Exists(ctx, oid)
			r, err := store.Get(ctx, oid)
			if err == nil {
				io.ReadAll(r)
				r.Close()
			}
			done <- true
		}(i)
	}

	for i := 0; i < 10; i++ {
		<-done
	}
}

func TestInMemoryStoreLargeObject(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	oid := "large-object-1234567890abcdef1234567890abcdef1234567890abcdef12"
	largeData := bytes.Repeat([]byte("X"), 10*1024*1024) // 10 MB

	if err := store.Put(ctx, oid, bytes.NewReader(largeData)); err != nil {
		t.Fatalf("Put() large object error = %v", err)
	}

	reader, err := store.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() large object error = %v", err)
	}
	defer reader.Close()

	got, _ := io.ReadAll(reader)
	if len(got) != len(largeData) {
		t.Errorf("large object length = %d, want %d", len(got), len(largeData))
	}
}
