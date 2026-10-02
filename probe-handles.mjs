process.on("SIGUSR2", () => {
  console.error(`[probe ${process.pid} ${process.argv.slice(1).join(" ")}] active: ${JSON.stringify(process.getActiveResourcesInfo())}`);
});
