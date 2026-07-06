package metadata

import (
	"context"
	"testing"
	"time"
)

func TestInMemoryStorePutAndGet(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	meta := &ObjectMeta{
		OID:       "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2",
		Size:      1048576,
		CreatedAt: time.Date(2026, 1, 15, 12, 0, 0, 0, time.UTC),
		Uploaded:  true,
	}

	if err := store.Put(ctx, meta); err != nil {
		t.Fatalf("Put() error = %v", err)
	}

	got, err := store.Get(ctx, meta.OID)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}

	if got.OID != meta.OID {
		t.Errorf("OID = %q, want %q", got.OID, meta.OID)
	}
	if got.Size != meta.Size {
		t.Errorf("Size = %d, want %d", got.Size, meta.Size)
	}
	if got.Uploaded != meta.Uploaded {
		t.Errorf("Uploaded = %v, want %v", got.Uploaded, meta.Uploaded)
	}
}

func TestInMemoryStoreGetNotFound(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	_, err := store.Get(ctx, "nonexistent-oid")
	if err == nil {
		t.Fatal("Get() expected error for nonexistent OID")
	}
}

func TestInMemoryStoreConcurrentAccess(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	done := make(chan bool, 10)
	for i := 0; i < 10; i++ {
		go func(n int) {
			oid := "oid-concurrent-" + string(rune('0'+n))
			store.Put(ctx, &ObjectMeta{OID: oid, Size: int64(n), Uploaded: true})
			store.Get(ctx, oid)
			done <- true
		}(i)
	}

	for i := 0; i < 10; i++ {
		<-done
	}

	meta, err := store.Get(ctx, "oid-concurrent-5")
	if err != nil {
		t.Fatalf("Get() after concurrent writes error = %v", err)
	}
	if meta.OID != "oid-concurrent-5" {
		t.Errorf("OID = %q after concurrent access", meta.OID)
	}
}

func TestInMemoryStoreOverwrite(t *testing.T) {
	ctx := context.Background()
	store := NewInMemoryStore()

	oid := "overwrite-oid"
	store.Put(ctx, &ObjectMeta{OID: oid, Size: 100, Uploaded: false})
	store.Put(ctx, &ObjectMeta{OID: oid, Size: 200, Uploaded: true})

	got, err := store.Get(ctx, oid)
	if err != nil {
		t.Fatalf("Get() error = %v", err)
	}
	if got.Size != 200 {
		t.Errorf("Size after overwrite = %d, want 200", got.Size)
	}
	if !got.Uploaded {
		t.Error("Uploaded should be true after overwrite")
	}
}
