{
  description = "Nix package for the Neon CLI";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];

      forAllSystems = nixpkgs.lib.genAttrs systems;
    in
    {
      packages = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          inherit (pkgs) lib;

          packageJson = builtins.fromJSON (builtins.readFile ./package.json);
          nodejs = pkgs.nodejs_26;
          pnpm = pkgs.pnpm_9.override { inherit nodejs; };

          pnpmDepsHash = "sha256-kwq0bstVMxMK5t2ILerTgz4N6VJ2GORvyw7K07oaOiQ=";

          neonctl = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "neonctl";
            inherit (packageJson) version;

            src = ./.;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              inherit pnpm;
              fetcherVersion = 3;
              hash = pnpmDepsHash;
            };

            nativeBuildInputs = [
              nodejs
              pkgs.makeWrapper
              pkgs.pnpmConfigHook
              pnpm
            ];

            postPatch = ''
              patchShebangs mocks/bin
            '';

            buildPhase = ''
              runHook preBuild

              pnpm run build

              runHook postBuild
            '';

            doCheck = true;
            checkPhase = ''
              runHook preCheck

              export HOME="$(mktemp -d)"
              export XDG_CONFIG_HOME="$HOME/.config"
              pnpm run test

              runHook postCheck
            '';

            installPhase = ''
              runHook preInstall

              mkdir -p "$out/bin" "$out/lib/neonctl"
              cp -R dist node_modules "$out/lib/neonctl/"
              node <<'EOF'
              const fs = require("fs");
              const path = require("path");

              const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));
              const modules = path.join(process.env.out, "lib", "neonctl", "node_modules");

              for (const name of Object.keys(pkg.devDependencies ?? {})) {
                fs.rmSync(path.join(modules, ...name.split("/")), {
                  recursive: true,
                  force: true,
                });

                if (name.startsWith("@")) {
                  const scopeDir = path.join(modules, name.split("/")[0]);
                  try {
                    if (fs.readdirSync(scopeDir).length === 0) {
                      fs.rmdirSync(scopeDir);
                    }
                  } catch (error) {
                    if (error.code !== "ENOENT") {
                      throw error;
                    }
                  }
                }
              }

              fs.rmSync(path.join(modules, ".bin"), { recursive: true, force: true });
              EOF
              makeWrapper ${lib.getExe nodejs} "$out/bin/neonctl" \
                --add-flags "$out/lib/neonctl/dist/cli.js"
              ln -s "$out/bin/neonctl" "$out/bin/neon"

              runHook postInstall
            '';

            meta = {
              description = packageJson.description;
              homepage = "https://github.com/neondatabase/neonctl";
              license = lib.licenses.mit;
              mainProgram = "neonctl";
              platforms = lib.platforms.linux;
            };
          });
        in
        {
          default = neonctl;
          inherit neonctl;
          pnpmDeps = neonctl.pnpmDeps;
        }
      );

      apps = forAllSystems (system: {
        default = {
          type = "app";
          program = "${self.packages.${system}.default}/bin/neonctl";
          meta.description = "Neon CLI";
        };
        neonctl = self.apps.${system}.default;
      });

      checks = forAllSystems (
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          neonctl = self.packages.${system}.default;
        in
        {
          default = pkgs.runCommand "neonctl-smoke-test" { nativeBuildInputs = [ neonctl ]; } ''
            neonctl --version | grep -F "${neonctl.version}"
            neon --version | grep -F "${neonctl.version}"
            neonctl --help >/dev/null
            touch "$out"
          '';
        }
      );

      formatter = forAllSystems (system: nixpkgs.legacyPackages.${system}.nixfmt);
    };
}
