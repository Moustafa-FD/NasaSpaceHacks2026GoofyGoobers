export interface Scenario {
  schemaVersion: "1.0";
  mode: "illustrative";
  name: string;
  region: { id: string; name: string; bbox: [number, number, number, number] };
  years: { start: number; end: number };
  assumptions: {
    itLoadMw: number;
    utilization: number;
    pue: number;
    annualGrowthRate: number;
    gridKgCo2ePerKwh: number;
    wueLitresPerItKwh: number;
    electricityPricePerKwh: number;
    currency: string;
  };
}

export type RunStatus = "queued" | "running" | "completed" | "failed";

export interface RunSnapshot {
  id: string;
  status: RunStatus;
  progress: number;
  createdAt: string;
  updatedAt: string;
  scenario: Scenario;
  error?: { code: string; message: string };
  resultUrl?: string;
}

export interface ResultManifest {
  schemaVersion: "1.0";
  runId: string;
  mode: "illustrative";
  modelVersion: string;
  scenarioName: string;
  region: Scenario["region"];
  years: Scenario["years"];
  provenance: {
    kind: "synthetic";
    sourceIds: string[];
    assumptions: Scenario["assumptions"];
    warnings: string[];
  };
  metrics: Array<{
    id: string;
    label: string;
    domain: string;
    unit: string;
    status: "illustrative";
    spatialResolution: string;
    temporalResolution: "annual";
    uncertainty: { status: "not_quantified"; reason: string };
    series: Array<{ year: number; value: number }>;
  }>;
  unavailable: Array<{ domain: string; reason: string }>;
  layers: unknown[];
}

export interface RunEvent { type: "run.status"; run: RunSnapshot }

export const DOMAINS = [
  { id: "energy", status: "illustrative", description: "Annual facility electricity accounting" },
  { id: "emissions", status: "illustrative", description: "Electricity-related inventory emissions only" },
  { id: "water-use", status: "illustrative", description: "Onsite cooling-water use; not net consumption or scarcity" },
  { id: "facility-bills", status: "illustrative", description: "Fixed unit-price energy charge; not a full utility tariff" },
  { id: "air-quality", status: "planned", description: "Calibrated transport/chemistry and air-quality indicators" },
  { id: "water-stress", status: "planned", description: "Source-specific watershed and groundwater balance" },
  { id: "water-quality", status: "planned", description: "Discharge, receiving-water chemistry and temperature" },
  { id: "household-bills", status: "planned", description: "Tariffs, grid costs and customer-class cost allocation" },
  { id: "employment", status: "planned", description: "Construction/operating jobs, labor force and unemployment rates" },
  { id: "population", status: "planned", description: "Population, growth rates, births, deaths and migration" },
  { id: "land-ecosystems", status: "planned", description: "Land cover, vegetation, heat and habitat indicators" },
  { id: "noise", status: "planned", description: "Acoustic sources, receptors, background and mitigation" }
] as const;
