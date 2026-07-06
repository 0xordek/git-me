// Package lfs implements the Git LFS server protocol.
package lfs

const (
	// ContentType is the required Content-Type for Git LFS Batch API requests and responses.
	ContentType = "application/vnd.git-lfs+json"

	// OperationUpload represents a Git LFS upload operation.
	OperationUpload = "upload"

	// OperationDownload represents a Git LFS download operation.
	OperationDownload = "download"
)

// BatchRequest is the JSON body sent by the Git LFS client to the Batch API endpoint.
type BatchRequest struct {
	Operation string        `json:"operation"`
	Transfers []string      `json:"transfers,omitempty"`
	Objects   []BatchObject `json:"objects"`
}

// BatchObject represents a single object in a batch request.
type BatchObject struct {
	OID  string `json:"oid"`
	Size int64  `json:"size"`
}

// BatchResponse is the JSON body returned by the Batch API endpoint.
type BatchResponse struct {
	Transfer string           `json:"transfer,omitempty"`
	Objects  []TransferObject `json:"objects"`
}

// TransferObject represents a single object in a batch response, including its actions or error.
type TransferObject struct {
	OID     string                  `json:"oid"`
	Size    int64                   `json:"size"`
	Actions map[string]ObjectAction `json:"actions,omitempty"`
	Error   *ObjectError            `json:"error,omitempty"`
}

// ObjectAction describes an upload or download action for a single object.
type ObjectAction struct {
	Href      string            `json:"href"`
	Header    map[string]string `json:"header,omitempty"`
	ExpiresAt string            `json:"expires_at,omitempty"`
}

// ObjectError represents an error for a specific object in a batch response.
type ObjectError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}
