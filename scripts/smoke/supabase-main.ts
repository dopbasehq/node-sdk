// The main service: hands each request to a user worker, as Supabase does.
Deno.serve(async (req: Request) => {
  const worker = await EdgeRuntime.userWorkers.create({
    servicePath: '/home/deno/functions/check',
    memoryLimitMb: 150,
    workerTimeoutMs: 60_000,
    noModuleCache: false,
    envVars: Object.entries(Deno.env.toObject()),
    forceCreate: true,
    cpuTimeSoftLimitMs: 10_000,
    cpuTimeHardLimitMs: 20_000,
  });
  return await worker.fetch(req);
});
