// Lets plain node import the Convex modules unchanged.
//
// Convex bundles with esbuild, so its source uses extensionless relative
// imports ("./images"). Node's ESM resolver requires the extension. Rather than
// edit the server code to suit the test rig — which would mean the rig no longer
// tests the shipped code — this hook fills the extension back in.
import { registerHooks } from "node:module";
import fs from "node:fs";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith(".") && !/\.[a-z]+$/i.test(specifier)) {
      for (const ext of [".ts", ".js", ".mjs"]) {
        try {
          const url = new URL(specifier + ext, context.parentURL);
          if (fs.existsSync(url)) return next(specifier + ext, context);
        } catch {}
      }
    }
    return next(specifier, context);
  },
});
