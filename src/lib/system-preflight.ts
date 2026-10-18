import si from 'systeminformation';
import os from 'node:os';
export type PreflightReport = {
  availableGb: number; totalGb: number; usedPercent: number; cpuPercent: number;
  busyProcesses: { name: string; cpu: number; memoryMb: number }[]; processCount: number;
  warnings: string[]; estimatedLeads: number; openEnded: boolean;
  minMinutes: number; maxMinutes: number; recommendation: string;
};
export async function systemPreflight(input: { leads: number; searches: number; enrich: boolean; workers: number; openEnded: boolean }): Promise<PreflightReport> {
  await si.currentLoad();
  await new Promise(resolve => setTimeout(resolve, 650));
  const [memory, cpu, processes] = await Promise.all([si.mem(), si.currentLoad(), si.processes()]);
  const totalGb = memory.total / 1024 ** 3;
  // On macOS systeminformation's `available` also includes wired/compressed
  // memory. Only free and inactive (reclaimable) pages can be budgeted safely.
  const availableBytes = process.platform === 'darwin' ? memory.free + memory.reclaimable : memory.available;
  const availableGb = Math.min(memory.total, availableBytes) / 1024 ** 3;
  const usedPercent = (1 - Math.min(memory.total, availableBytes) / memory.total) * 100;
  const cpuPercent = Math.min(100, cpu.currentLoad);
  const busyProcesses = processes.list.filter(p => p.pid !== process.pid && (p.cpu > 8 || p.memRss > 768 * 1024))
    .sort((a,b) => b.cpu - a.cpu).slice(0,8).map(p => ({ name: p.name, cpu: Math.round(p.cpu), memoryMb: Math.round(p.memRss / 1024) }));
  const warnings: string[] = [];
  if (availableGb < 3 || usedPercent > 85) warnings.push('Es ist wenig Arbeitsspeicher frei. Schließe andere Programme und Browser-Tabs.');
  if (memory.swapused > 1024 ** 3) warnings.push('Der Computer hat bereits Arbeitsspeicher ausgelagert. Schließe nicht benötigte Programme, bevor du eine große Recherche startest.');
  if (cpuPercent > 75) warnings.push('Dein Prozessor ist bereits stark ausgelastet. Beende andere rechenintensive Aufgaben.');
  if (busyProcesses.length >= 3) warnings.push('Mehrere andere Prozesse benötigen gerade viel Leistung oder RAM. Schließe möglichst alle anderen Programme.');
  const workers = Math.max(1, Math.min(input.workers || (totalGb > 16 ? 4 : totalGb > 8 ? 3 : 2), os.availableParallelism(), Math.max(1, Math.floor(availableGb / 1.5))));
  const pressure = warnings.length ? 1.6 : 1;
  const leads = Math.max(1, input.leads);
  // Conservative planning range; not a throughput guarantee or benchmark.
  const minMinutes = Math.max(1, Math.ceil((input.searches * 15 + leads * (input.enrich ? 4 / workers : 0.7)) / 60));
  const maxMinutes = Math.max(minMinutes + 1, Math.ceil((input.searches * 90 + leads * (input.enrich ? 24 / workers : 3)) * pressure / 60));
  return { availableGb: Math.round(availableGb * 10) / 10, totalGb: Math.round(totalGb), usedPercent: Math.round(usedPercent), cpuPercent: Math.round(cpuPercent),
    busyProcesses, processCount: processes.all, warnings, estimatedLeads: leads, openEnded: input.openEnded, minMinutes, maxMinutes,
    recommendation: 'Plane ein, den Computer während der Recherche möglichst nicht zu nutzen. Lass ihn am Strom, online und den Deckel geöffnet. Bildschirm und Ruhezustand werden während des Auftrags wachgehalten.',
  };
}
