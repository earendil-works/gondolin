/** @type {import("dependency-cruiser").IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: "no-circular",
      severity: "error",
      from: {},
      to: { circular: true },
    },
    {
      name: "no-mitm-vfs-to-vm-internals",
      severity: "error",
      from: { path: "^src/vm/mitm-vfs\\.ts$" },
      to: {
        path: "^src/vm/",
        pathNot: "^src/vm/types\\.ts$",
      },
    },
  ],
  options: {
    tsConfig: {
      fileName: "tsconfig.json",
    },
    includeOnly: "^src",
    doNotFollow: {
      path: "node_modules",
    },
    reporterOptions: {
      dot: {
        collapsePattern: "node_modules/[^/]+",
      },
    },
  },
};
