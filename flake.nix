{
  description = "mx-multiplayer: Network synchronisation for the nerima-games Minecraft-clone rebuild: wire protocol, frame codec, connection state machine, snapshot interpolation and the transport Port. Multiplayer screens belong to mx-ui.";

  inputs = {
    # nixos-unstable, not nixpkgs-unstable: it advances only after the NixOS
    # release tests pass, so it is less likely to land a broken build.
    #
    # flake.lock is pinned (via `nix flake lock --override-input nixpkgs
    # github:NixOS/nixpkgs/624af665418d3c65d544145b4d34ad696439570e`, not
    # `nix flake update`) to the last revision before nixos-unstable's oxlint
    # moved to >=1.79.0: that version's `no-redeclare` false-positives on the
    # `type X = ... & Brand` + `const X = Brand.refined(...)` idiom used
    # throughout this repository's `effect` Brand types (A/B-proven against
    # 1.75.0, which is clean). Re-check this pin on the next toolchain bump.
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    { nixpkgs, ... }:
    let
      # Only what is actually exercised: x86_64-linux by CI, aarch64-darwin by
      # the maintainer. Declaring a platform nothing builds makes
      # `nix flake check --all-systems` fail rather than skip it.
      systems = [
        "x86_64-linux"
        "aarch64-darwin"
      ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      pkgsFor = system: nixpkgs.legacyPackages.${system};
    in
    {
      devShells = forAllSystems (
        system:
        let
          pkgs = pkgsFor system;
        in
        {
          # Node 24 matches the `engines` field and the CI runner. pnpm comes
          # from corepack rather than nixpkgs so that the version is decided by
          # the `packageManager` field in package.json — one source of truth
          # instead of two that can drift.
          #
          # oxlint and ast-grep are NOT package.json devDependencies. They used
          # to be, and every repo in the org independently drifted onto a
          # different version without anyone noticing. A single pinned
          # Nix-provided oxlint/ast-grep is the one source of truth instead of
          # 16 independently-drifting npm pins.
          default = pkgs.mkShell {
            packages = [
              pkgs.nodejs_24
              pkgs.corepack_24
              pkgs.typescript-language-server
              pkgs.oxlint
              pkgs.ast-grep
            ];

            shellHook = ''
              corepackDir="$(mktemp -d "''${TMPDIR:-/tmp}/mx-multiplayer-corepack.XXXXXX")"
              corepack enable --install-directory "$corepackDir"
              export PATH="$corepackDir:$PATH"
            '';
          };
        }
      );
    };
}
