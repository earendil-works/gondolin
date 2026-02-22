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
      name: "no-ssh-utils-to-qemu",
      severity: "error",
      from: { path: "^src/ssh/utils\\.ts$" },
      to: { path: "^src/qemu/" },
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
    {
      name: "no-http-to-qemu-internals",
      severity: "error",
      from: { path: "^src/http/" },
      to: {
        path: "^src/qemu/",
        pathNot: "^src/qemu/contracts\\.ts$",
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
