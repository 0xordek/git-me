package lfs

import (
	"bytes"
	"context"
	"io"
	"time"

	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

// HandleUpload stores a binary object and records its metadata.
func HandleUpload(
	ctx context.Context,
	oid string,
	reader io.Reader,
	store storage.ObjectStore,
	metaStore metadata.MetadataStore,
) error {
	data, err := io.ReadAll(reader)
	if err != nil {
		return err
	}

	if err := store.Put(ctx, oid, bytes.NewReader(data)); err != nil {
		return err
	}

	meta := &metadata.ObjectMeta{
		OID:       oid,
		Size:      int64(len(data)),
		CreatedAt: time.Now().UTC(),
		Uploaded:  true,
	}
	return metaStore.Put(ctx, meta)
}
