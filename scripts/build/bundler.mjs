import fs from "node:fs/promises";
import path from "node:path";
import createEsmUtils from "esm-utils";
import * as babel from "@babel/core";
import esbuild from "esbuild";
import { NodeModulesPolyfillPlugin as esbuildPluginNodeModulePolyfills } from "@esbuild-plugins/node-modules-polyfill";
import browserslistToEsbuild from "browserslist-to-esbuild";
import { PROJECT_ROOT, DIST_DIR } from "../utils/index.mjs";
import esbuildPluginEvaluate from "./esbuild-plugins/evaluate.mjs";
import esbuildPluginReplaceModule from "./esbuild-plugins/replace-module.mjs";
import esbuildPluginReplaceText from "./esbuild-plugins/replace-text.mjs";
import esbuildPluginLicense from "./esbuild-plugins/license.mjs";
import esbuildPluginUmd from "./esbuild-plugins/umd.mjs";
import esbuildPluginVisualizer from "./esbuild-plugins/visualizer.mjs";
import esbuildPluginThrowWarnings from "./esbuild-plugins/throw-warnings.mjs";
import bundles from "./config.mjs";

const { __dirname, readJsonSync, require } = createEsmUtils(import.meta);
const packageJson = readJsonSync("../../package.json");

const umdTarget = browserslistToEsbuild(packageJson.browserslist);
const EMPTY_MODULE_REPLACEMENT = { contents: "" };

function getBabelConfig(bundle) {
  const config = {
    babelrc: false,
    assumptions: {
      setSpreadProperties: true,
    },
    sourceType: "unambiguous",
    plugins: bundle.babelPlugins || [],
    compact: false,
    exclude: [/\/core-js\//],
  };
  const targets = { node: "10" };
  if (bundle.target === "universal") {
    targets.browsers = packageJson.browserslist;
  }
  config.presets = [
    [
      "@babel/preset-env",
      {
        targets,
        exclude: [
          "es.array.unscopables.flat",
          "es.array.unscopables.flat-map",
          "es.array.sort",
          "es.promise",
          "es.promise.finally",
          "es.string.replace",
          "es.symbol.description",
          "es.typed-array.*",
          "web.*",
        ],
        modules: false,
        useBuiltIns: "usage",
        corejs: {
          version: 3,
        },
        debug: false,
      },
    ],
  ];
  config.plugins.push([
    "@babel/plugin-proposal-object-rest-spread",
    { useBuiltIns: true },
  ]);
  return config;
}

const bundledFiles = [
  ...bundles,
  { input: "package.json", output: "package.json" },
].map(({ input, output }) => ({
  input: path.join(PROJECT_ROOT, input),
  output: `./${output}`,
}));

function* getEsbuildOptions(bundle, buildOptions) {
  const replaceText = [
    // `tslib` exports global variables
    {
      file: require.resolve("tslib"),
      find: "factory(createExporter(root",
      replacement: "factory(createExporter({}",
    },
  ];

  const define = {
    "process.env.PRETTIER_TARGET": JSON.stringify(bundle.target),
    "process.env.NODE_ENV": JSON.stringify("production"),
  };

  if (bundle.target === "universal") {
    // We can't reference `process` in UMD bundles and this is
    // an undocumented "feature"
    replaceText.push({
      file: "*",
      find: "process.env.PRETTIER_DEBUG",
      replacement: "globalThis.PRETTIER_DEBUG",
    });

    define.process = JSON.stringify({ env: {}, argv: [] });

    // Replace `__dirname` and `__filename` with a fake value
    // So `parser-typescript.js` won't contain a path of working directory
    // See #8268
    define.__filename = JSON.stringify(
      "/prettier-security-filename-placeholder.js"
    );
    define.__dirname = JSON.stringify("/prettier-security-dirname-placeholder");
  }

  const replaceModule = {};
  // Replace other bundled files
  if (bundle.target === "node") {
    // Replace bundled files and `package.json` with dynamic `require()`
    for (const { input, output } of bundledFiles) {
      replaceModule[input] = { path: output, external: true };
    }
  } else {
    // Universal bundle only use version info from package.json
    // Replace package.json with `{version: "{VERSION}"}`
    replaceModule[path.join(PROJECT_ROOT, "package.json")] = {
      contents: JSON.stringify({ version: packageJson.version }),
      loader: "json",
    };

    // Replace parser getters with `undefined`
    for (const file of [
      "src/language-css/parsers.js",
      "src/language-graphql/parsers.js",
      "src/language-handlebars/parsers.js",
      "src/language-html/parsers.js",
      "src/language-js/parse/parsers.js",
      "src/language-markdown/parsers.js",
      "src/language-yaml/parsers.js",
    ]) {
      replaceModule[path.join(PROJECT_ROOT, file)] = EMPTY_MODULE_REPLACEMENT;
    }

    // Prevent `esbuildPluginNodeModulePolyfills` include shim for this module
    replaceModule.assert = require.resolve("./shims/assert.cjs");
  }

  let shouldMinify = buildOptions.minify;
  if (typeof shouldMinify !== "boolean") {
    shouldMinify = bundle.minify !== false && bundle.target === "universal";
  }

  const esbuildOptions = {
    entryPoints: [path.join(PROJECT_ROOT, bundle.input)],
    define,
    bundle: true,
    metafile: true,
    plugins: [
      esbuildPluginEvaluate(),
      esbuildPluginReplaceModule({ ...replaceModule, ...bundle.replaceModule }),
      bundle.target === "universal" && esbuildPluginNodeModulePolyfills(),
      esbuildPluginReplaceText({
        filter: /\.[cm]?js$/,
        replacements: [...replaceText, ...(bundle.replaceText ?? [])],
      }),
      buildOptions.onLicenseFound &&
        esbuildPluginLicense({
          cwd: PROJECT_ROOT,
          thirdParty: {
            includePrivate: true,
            output: buildOptions.onLicenseFound,
          },
        }),
      buildOptions.reports &&
        esbuildPluginVisualizer({ formats: buildOptions.reports }),
      esbuildPluginThrowWarnings(),
    ].filter(Boolean),
    minify: shouldMinify,
    legalComments: "none",
    external: [...(bundle.external ?? [])],
    // Disable esbuild auto discover `tsconfig.json` file
    tsconfig: path.join(__dirname, "empty-tsconfig.json"),
    mainFields: ["main"],
    target: [...(bundle.esbuildTarget ?? ["node10"])],
    logLevel: "error",
  };

  if (bundle.target === "universal") {
    if (!bundle.esbuildTarget) {
      esbuildOptions.target.push(...umdTarget);
    }

    yield {
      ...esbuildOptions,
      outfile: bundle.output,
      plugins: [
        esbuildPluginUmd({ name: bundle.name }),
        ...esbuildOptions.plugins,
      ],
      format: "umd",
    };

    if (/^(?:standalone|parser-.*)\.js$/.test(bundle.output)) {
      yield {
        ...esbuildOptions,
        outfile: `esm/${bundle.output.replace(".js", ".mjs")}`,
        format: "esm",
      };
    }
  } else {
    esbuildOptions.platform = "node";
    esbuildOptions.external.push(...bundledFiles.map(({ output }) => output));

    yield {
      ...esbuildOptions,
      outfile: bundle.output,
      format: "cjs",
    };
  }
}

async function runBuild(bundle, esbuildOptions, buildOptions) {
  if (!buildOptions.babel || bundle.skipBabel) {
    await esbuild.build(esbuildOptions);
    return;
  }

  const { format, plugins, outfile } = esbuildOptions;

  await esbuild.build({
    ...esbuildOptions,
    plugins: plugins.filter(({ name }) => name !== "umd"),
    format: format === "umd" ? "cjs" : format,
    minify: false,
    target: undefined,
  });

  const text = await fs.readFile(outfile);

  const { code } = await babel.transformAsync(text, {
    filename: outfile,
    ...getBabelConfig(bundle),
  });
  await fs.writeFile(outfile, code);

  await esbuild.build({
    ...esbuildOptions,
    define: {},
    plugins: plugins.filter(
      ({ name }) => name === "umd" || name === "throw-warnings"
    ),
    entryPoints: [outfile],
    allowOverwrite: true,
  });
}

async function* createBundle(bundle, buildOptions) {
  for (const esbuildOptions of getEsbuildOptions(bundle, buildOptions)) {
    const { outfile: file } = esbuildOptions;

    if (
      (buildOptions.files && !buildOptions.files.has(file)) ||
      (buildOptions.playground && esbuildOptions.format !== "umd")
    ) {
      yield { name: file, skipped: true };
      continue;
    }

    const relativePath = buildOptions.saveAs || file;
    const absolutePath = path.join(DIST_DIR, relativePath);

    esbuildOptions.outfile = absolutePath;

    yield { name: file, started: true };
    await runBuild(bundle, esbuildOptions, buildOptions);
    yield { name: file, relativePath, absolutePath };
  }
}

export default createBundle;
