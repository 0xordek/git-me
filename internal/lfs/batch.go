package lfs

import (
	"context"
	"errors"
	"fmt"

	"github.com/ordek1/git-me/internal/metadata"
	"github.com/ordek1/git-me/internal/storage"
)

// HandleBatch processes a Git LFS batch request and returns the appropriate
// upload or download actions for each object.
func HandleBatch(
	ctx context.Context,
	req *BatchRequest,
	store storage.ObjectStore,
	metaStore metadata.MetadataStore,
) (*BatchResponse, error) {
	switch req.Operation {
	case OperationUpload:
		return handleBatchUpload(req), nil
	case OperationDownload:
		return handleBatchDownload(ctx, req, metaStore), nil
	default:
		return nil, errors.New("lfs: unknown batch operation: " + req.Operation)
	}
}

func handleBatchUpload(req *BatchRequest) *BatchResponse {
	objects := make([]TransferObject, len(req.Objects))
	for i, obj := range req.Objects {
		objects[i] = TransferObject{
			OID:  obj.OID,
			Size: obj.Size,
			Actions: map[string]ObjectAction{
				"upload": {
					Href: fmt.Sprintf("/objects/%s", obj.OID),
				},
			},
		}
	}
	return &BatchResponse{
		Transfer: "basic",
		Objects:  objects,
	}
}

func handleBatchDownload(ctx context.Context, req *BatchRequest, metaStore metadata.MetadataStore) *BatchResponse {
	objects := make([]TransferObject, len(req.Objects))
	for i, obj := range req.Objects {
		meta, err := metaStore.Get(ctx, obj.OID)
		if err != nil || !meta.Uploaded {
			objects[i] = TransferObject{
				OID:   obj.OID,
				Size:  obj.Size,
				Error: &ObjectError{Code: 404, Message: "object not found"},
			}
			continue
		}
		objects[i] = TransferObject{
			OID:  obj.OID,
			Size: meta.Size,
			Actions: map[string]ObjectAction{
				"download": {
					Href: fmt.Sprintf("/objects/%s", obj.OID),
				},
			},
		}
	}
	return &BatchResponse{
		Transfer: "basic",
		Objects:  objects,
	}
}
