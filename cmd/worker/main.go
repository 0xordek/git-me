//go:build tinygo.wasm

// Package main is the Cloudflare Worker entrypoint for git-me.
package main

import (
	"net/http"

	"github.com/0xordek/git-me/internal/worker"
)

func main() {
	http.HandleFunc("/", worker.HandleRequest)
}
