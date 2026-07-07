package lfs

import (
	"errors"
	"fmt"
	"mime"
)

// ValidateOID checks that oid is a Git LFS SHA-256 hex digest.
func ValidateOID(oid string) error {
	if len(oid) != 64 {
		return fmt.Errorf("lfs: invalid oid length: %d", len(oid))
	}
	for _, r := range oid {
		isDigit := r >= '0' && r <= '9'
		isLowerHex := r >= 'a' && r <= 'f'
		isUpperHex := r >= 'A' && r <= 'F'
		if !isDigit && !isLowerHex && !isUpperHex {
			return errors.New("lfs: oid must be hex")
		}
	}
	return nil
}

// SelectTransfer chooses the Git LFS transfer adapter. Only basic is supported.
func SelectTransfer(transfers []string) (string, error) {
	if len(transfers) == 0 {
		return "basic", nil
	}
	for _, transfer := range transfers {
		if transfer == "basic" {
			return "basic", nil
		}
	}
	return "", errors.New("lfs: unsupported transfer adapter")
}

// ValidateBatchRequest validates operation-independent object fields and transfer support.
func ValidateBatchRequest(req *BatchRequest) error {
	if req == nil {
		return errors.New("lfs: batch request is required")
	}
	if _, err := SelectTransfer(req.Transfers); err != nil {
		return err
	}
	for _, obj := range req.Objects {
		if err := ValidateOID(obj.OID); err != nil {
			return err
		}
		if obj.Size < 0 {
			return errors.New("lfs: object size must not be negative")
		}
	}
	return nil
}

// IsLFSContentType reports whether contentType is the Git LFS JSON media type.
func IsLFSContentType(contentType string) bool {
	mediaType, _, err := mime.ParseMediaType(contentType)
	if err != nil {
		return false
	}
	return mediaType == ContentType
}
