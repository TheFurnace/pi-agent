{
  description = "pi-agent dev environment";

  inputs = {
    nixpkgs.follows = "nixos/nixpkgs";
    nixos.url       = "git+file:///home/dev/nixos";
    beads.follows   = "nixos/beads";
  };

  outputs = { nixpkgs, beads, ... }:
    let
      system = "x86_64-linux";
      pkgs   = nixpkgs.legacyPackages.${system};

      bd = beads.packages.${system}.default;
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
