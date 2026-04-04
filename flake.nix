{
  description = "pi-agent dev environment";

  inputs = {
    nixpkgs.follows = "nixos/nixpkgs";
    nixos.url       = "git+file:///home/dev/nixos";
  };

  outputs = { nixpkgs, ... }:
    let
      system = "x86_64-linux";
      pkgs   = nixpkgs.legacyPackages.${system};

      bd = pkgs.stdenv.mkDerivation {
        pname   = "beads";
        version = "1.0.0";
        src = pkgs.fetchurl {
          url    = "https://github.com/gastownhall/beads/releases/download/v1.0.0/beads_1.0.0_linux_amd64.tar.gz";
          sha256 = "7057db1e92428fcf5c08d5dc6b07ead57e588b262cba78b9a26893d55bd29fdb";
        };
        sourceRoot   = ".";
        nativeBuildInputs = [ pkgs.autoPatchelfHook ];
        buildInputs       = [ pkgs.stdenv.cc.cc.lib pkgs.icu74 ];
        installPhase = ''
          mkdir -p $out/bin
          cp bd $out/bin/bd
        '';
      };
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.bun
          bd
        ];
      };
    };
}
