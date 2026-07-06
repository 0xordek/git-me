package lfs

// LfsError is the standard Git LFS error response body.
type LfsError struct {
	Message          string `json:"message"`
	DocumentationURL string `json:"documentation_url,omitempty"`
	RequestID        string `json:"request_id,omitempty"`
}
