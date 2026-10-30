module.exports = {
  apps: [
    {
      name: "um-node",
      script: "um-node.py",
      interpreter: "python3",
      cwd: "/opt/universal-monitor",
      args: "run --config /opt/universal-monitor/nodes/um-node.json",
    },
    {
      name: "um-web",
      script: "website/app.py",
      interpreter: "python3",
      cwd: "/opt/universal-monitor",
    },
  ],
};
