description = "Local LLM server (llama.cpp), pinned CPU/Metal build."
binaries = ["llama-server"]
strip = 1

platform "darwin" "arm64" {
  source = "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-macos-arm64.tar.gz"
}

platform "darwin" "amd64" {
  source = "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-macos-x64.tar.gz"
}

platform "linux" "arm64" {
  source = "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-ubuntu-arm64.tar.gz"
}

platform "linux" "amd64" {
  source = "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-ubuntu-x64.tar.gz"
}

version "11146" {}

sha256sums = {
  "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-macos-arm64.tar.gz": "1ad3f9eff80edb9dbef4259ad564d1720612ef7eea48fa4afed0e54f5f3d5711",
  "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-macos-x64.tar.gz": "305f0e3a17d2c01eb205cd0a62128357f1ec3b55329cb084d94e5ec0115d7a3b",
  "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-ubuntu-arm64.tar.gz": "4aeda6fe68831547e49b7fa87607383ca5352b3d72ca5f70d52ed265f58c131f",
  "https://github.com/ggml-org/llama.cpp/releases/download/b11146/llama-b11146-bin-ubuntu-x64.tar.gz": "c150306eb16b5ab696f76a8bdf810c35fd98a24e82158742e6fa28f420ff8410",
}
