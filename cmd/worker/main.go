//go:build tinygo.wasm

// Package main is the Cloudflare Worker entrypoint for git-me.
package main

import (
	"net/http"

	"github.com/ordek1/git-me/internal/worker"
)

func main() {
	http.HandleFunc("/", worker.HandleRequest)
}
