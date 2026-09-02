class HerdrMise < Formula
  desc "Read-only Herdr observability kitchen"
  homepage "https://github.com/funsaized/herdr-mise"
  version "0.1.0"
  license "MIT"

  on_macos do
    if Hardware::CPU.arm?
      url "https://github.com/funsaized/herdr-mise/releases/download/v0.1.0/herdr-mise-v0.1.0-aarch64-apple-darwin.tar.gz"
      sha256 "5c8b56812dbd48ee5517871ad0c6ccff9512d8c37255d29dbb39f5889190985d"
    else
      url "https://github.com/funsaized/herdr-mise/releases/download/v0.1.0/herdr-mise-v0.1.0-x86_64-apple-darwin.tar.gz"
      sha256 "b5f16da202d7a8dc9b5be948f964daa50686df5534800d81fb4b8ade551443bf"
    end
  end

  on_linux do
    url "https://github.com/funsaized/herdr-mise/releases/download/v0.1.0/herdr-mise-v0.1.0-x86_64-unknown-linux-gnu.tar.gz"
    sha256 "d4facb3c9cd727dda82e49be5afc542977e283e2a62634b9f57461368b5f9771"
    depends_on arch: :x86_64
  end

  def install
    bin.install "herdr-mise"
    doc.install "LICENSE", "THIRD_PARTY_NOTICES.txt"
    (var/"log").mkpath
  end

  service do
    run opt_bin/"herdr-mise"
    log_path var/"log/herdr-mise.log"
    error_log_path var/"log/herdr-mise.error.log"
  end
end
