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
    in
    {
      devShells.${system}.default = pkgs.mkShell {
        packages = [];
      };
    };
}
