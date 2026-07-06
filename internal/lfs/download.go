package lfs

import (
	"context"
	"errors"
	"io"

	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

// HandleDownload retrieves a stored object and its size for streaming to the client.
func HandleDownload(
	ctx context.Context,
	oid string,
	store storage.ObjectStore,
	metaStore metadata.MetadataStore,
) (io.ReadCloser, int64, error) {
	meta, err := metaStore.Get(ctx, oid)
	if err != nil {
		return nil, 0, errors.New("lfs: object not found: " + oid)
	}
	if !meta.Uploaded {
		return nil, 0, errors.New("lfs: object not fully uploaded: " + oid)
	}

	reader, err := store.Get(ctx, oid)
	if err != nil {
		return nil, 0, err
	}

	return reader, meta.Size, nil
}
