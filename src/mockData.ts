// src/mockData.ts
// Mock dataset (sementara) — nanti bisa diganti DB/EMR/LIS.
// Pemilik: Intramedika
//
// ✅ Align dengan GraphQL schema (Dashboard FULL + enums)
// ✅ Tetap boleh simpan field ekstra pasien (age, allergies, dll) untuk future use

/* ---------------------------
 * TYPES (internal only)
 * --------------------------- */

type ExternalServiceStatus = "ONLINE" | "LATENCY" | "OFFLINE";
type TrendDirection = "STABLE" | "RISING" | "FALLING";

type ResourceCategory = "BEDS" | "DEVICE" | "MEDS" | "CONSUMABLE" | "OTHER";
type ResourceStatus = "OK" | "WARNING" | "CRITICAL";

type QueueTrend = "STABLE" | "INCREASING" | "DECREASING";

type RiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";

export type MockPatient = {
  id: string;
  name: string;

  // Fields used by GraphQL schema Patient
  mrn?: string;
  careUnit?: string;
  attendingDoctor?: string;
  attendingDoctorSip?: string;

  // Extra fields (not exposed by schema right now)
  age?: number;
  gender?: string;
  allergies?: string[];
  lastVisit?: string;
  diagnosis?: string;
};

export type MockEncounter = {
  id: string; // encounterId
  patientId: string;
  unitId: string;
  startedAt: string; // ISO string
};

export type MockLab = {
  id: string;
  testName: string;
  value?: string;
  unit?: string;
  flag?: string; // "H" | "L" | "N" | etc
  date?: string; // ISO/date
  refRange?: string;
};

type DashboardKpis = {
  occupancyRate: number;
  losAverage: number;
  staffAvailability: number;
  activeAlerts: number;
};

type ExternalServiceStatusItem = {
  name: string;
  status: ExternalServiceStatus;
  latencyMs: number;
  trend: TrendDirection;
};

type ResourceItem = {
  name: string;
  category: ResourceCategory;
  currentStock: number;
  totalCapacity: number;
  unit: string;
  status: ResourceStatus;
};

type QueueItem = {
  location: string;
  currentQueueLength: number;
  estimatedWaitTimeMinutes: number;
  predictionTrend: QueueTrend;
};

type DashboardPatient = {
  id: string;
  name: string;
  mrn?: string;
  room?: string;
  riskScore: number;
  riskLevel: RiskLevel;
  aiPrediction?: string;
  aiAction?: string;
  diagnosis?: string;
};

export type MockDashboard = {
  unitId: string;
  unitName: string;
  kpis: DashboardKpis;
  growthInsights: string[];
  externalServices: ExternalServiceStatusItem[];
  resources: ResourceItem[];
  queues: QueueItem[];
  patients: DashboardPatient[];
};

/* ---------------------------
 * MOCK DB
 * --------------------------- */

export const MOCK_PATIENTS: Record<string, MockPatient> = {
  "PAT-001": {
    id: "PAT-001",
    name: "Budi Santoso",
    age: 45,
    gender: "Laki-laki",
    mrn: "INTRA-2024-8892",
    allergies: ["Penicillin", "Kacang"],
    lastVisit: "2023-11-15",
    diagnosis: "Pneumonia Berat",
    careUnit: "Unit Rawat Jalan",
    attendingDoctor: "Dr. Anindya Putri",
    attendingDoctorSip: "445/123/SIP-DS/2023",
  },
  "PAT-002": {
    id: "PAT-002",
    name: "Siti Aminah",
    age: 52,
    gender: "Perempuan",
    mrn: "INTRA-7721",
    allergies: [],
    lastVisit: "2024-01-10",
    diagnosis: "Diabetes Mellitus Tipe 2",
    careUnit: "Poli Penyakit Dalam",
    attendingDoctor: "Dr. Hartono Sp.PD",
    attendingDoctorSip: "445/998/SIP-DS/2020",
  },
  "PAT-003": {
    id: "PAT-003",
    name: "Ahmad Dahlan",
    age: 60,
    gender: "Laki-laki",
    mrn: "INTRA-9932",
    allergies: ["Sulfa"],
    lastVisit: "2024-02-01",
    diagnosis: "Hipertensi Grade 1",
    careUnit: "Poli Jantung",
    attendingDoctor: "Dr. Sarah Sp.JP",
    attendingDoctorSip: "445/551/SIP-JP/2021",
  },
};

// ✅ 1 encounter per pasien (minimal), unit konsisten
export const MOCK_ENCOUNTERS: MockEncounter[] = [
  {
    id: "ENC-20260104-001",
    patientId: "PAT-001",
    unitId: "UNIT-RJ-01",
    startedAt: "2026-01-04T09:10:00+07:00",
  },
  {
    id: "ENC-20260104-002",
    patientId: "PAT-002",
    unitId: "UNIT-RJ-01",
    startedAt: "2026-01-04T09:30:00+07:00",
  },
  {
    id: "ENC-20260104-003",
    patientId: "PAT-003",
    unitId: "UNIT-RJ-01",
    startedAt: "2026-01-04T10:00:00+07:00",
  },
];

// ✅ Lab by encounter (align schema LabItem + tambahan refRange utk context)
export const MOCK_LABS_BY_ENCOUNTER: Record<string, MockLab[]> = {
  "ENC-20260104-001": [
    { id: "LAB-1", testName: "Hb", value: "10.1", unit: "g/dL", flag: "L", refRange: "13-17", date: "2026-01-04" },
    { id: "LAB-2", testName: "Leukosit", value: "15.2", unit: "10^3/uL", flag: "H", refRange: "4.0-10.0", date: "2026-01-04" },
    { id: "LAB-3", testName: "CRP", value: "120", unit: "mg/L", flag: "H", refRange: "<5", date: "2026-01-04" },
    { id: "LAB-4", testName: "Kreatinin", value: "1.8", unit: "mg/dL", flag: "H", refRange: "0.6-1.2", date: "2026-01-04" },
  ],
  "ENC-20260104-002": [
    { id: "LAB-5", testName: "Gula Darah Puasa", value: "140", unit: "mg/dL", flag: "H", refRange: "70-100", date: "2026-01-04" },
    { id: "LAB-6", testName: "HbA1c", value: "8.2", unit: "%", flag: "H", refRange: "<6.5", date: "2026-01-04" },
  ],
  "ENC-20260104-003": [
    { id: "LAB-7", testName: "Kolesterol Total", value: "210", unit: "mg/dL", flag: "H", refRange: "<200", date: "2026-01-04" },
    { id: "LAB-8", testName: "LDL", value: "145", unit: "mg/dL", flag: "H", refRange: "<100", date: "2026-01-04" },
  ],
};

/* ---------------------------
 * DASHBOARD (FULL)
 * --------------------------- */

// Helper supaya MRN di dashboard selalu konsisten dengan master patient
function patientMrn(patientId: string): string | undefined {
  return MOCK_PATIENTS[patientId]?.mrn;
}

function patientName(patientId: string): string {
  return MOCK_PATIENTS[patientId]?.name || patientId;
}

function patientDiagnosis(patientId: string): string | undefined {
  return MOCK_PATIENTS[patientId]?.diagnosis;
}

/**
 * ✅ Dashboard full (align dengan DashboardTab FE + GraphQL schema Dashboard)
 * NOTE: unitId bisa dioverride oleh resolver dashboard(unitId)
 */
export const MOCK_DASHBOARD: MockDashboard = {
  unitId: "UNIT-RJ-01",
  unitName: "Rawat Jalan - Penyakit Dalam",
  kpis: {
    occupancyRate: 85,
    losAverage: 3.2,
    staffAvailability: 92,
    activeAlerts: 5,
  },
  growthInsights: [
    "Lonjakan kunjungan Pasien Hipertensi (20%) terdeteksi di Q1.",
    "Potensi revenue loss IDR 50M akibat antrian poli > 2 jam.",
    "Utilisasi MRI meningkat, pertimbangkan penambahan shift sore.",
  ],
  externalServices: [
    { name: "SatuSehat", status: "ONLINE", latencyMs: 45, trend: "STABLE" },
    { name: "BPJS P-Care", status: "LATENCY", latencyMs: 2400, trend: "RISING" },
    { name: "Admedika", status: "ONLINE", latencyMs: 120, trend: "STABLE" },
  ],
  resources: [
    { name: "ICU Beds", category: "BEDS", currentStock: 2, totalCapacity: 10, unit: "bed", status: "CRITICAL" },
    { name: "Ventilator", category: "DEVICE", currentStock: 2, totalCapacity: 5, unit: "unit", status: "WARNING" },
    { name: "Amlodipine 10mg", category: "MEDS", currentStock: 1500, totalCapacity: 5000, unit: "tab", status: "OK" },
    { name: "Masker N95", category: "CONSUMABLE", currentStock: 50, totalCapacity: 500, unit: "box", status: "CRITICAL" },
  ],
  queues: [
    { location: "Poli Jantung", currentQueueLength: 24, estimatedWaitTimeMinutes: 45, predictionTrend: "INCREASING" },
    { location: "Laboratorium", currentQueueLength: 8, estimatedWaitTimeMinutes: 15, predictionTrend: "STABLE" },
    { location: "Farmasi", currentQueueLength: 35, estimatedWaitTimeMinutes: 60, predictionTrend: "INCREASING" },
  ],
  patients: [
    {
      id: "PAT-001",
      name: patientName("PAT-001"),
      mrn: patientMrn("PAT-001"),
      room: "R.201",
      riskScore: 92,
      riskLevel: "CRITICAL",
      aiPrediction: "Risiko Sepsis (High) - 24j",
      aiAction: "Cek Kultur Darah & Laktat Segera",
      diagnosis: patientDiagnosis("PAT-001"),
    },
    {
      id: "PAT-002",
      name: patientName("PAT-002"),
      mrn: patientMrn("PAT-002"),
      room: "R.202",
      riskScore: 75,
      riskLevel: "HIGH",
      aiPrediction: "Hipoglikemia Nokturnal",
      aiAction: "Sesuaikan Dosis Insulin Malam",
      diagnosis: patientDiagnosis("PAT-002"),
    },
    {
      id: "PAT-003",
      name: patientName("PAT-003"),
      mrn: patientMrn("PAT-003"),
      room: "R.203",
      riskScore: 45,
      riskLevel: "MEDIUM",
      aiPrediction: "Stabil",
      aiAction: "Lanjut Terapi Oral",
      diagnosis: patientDiagnosis("PAT-003"),
    },
  ],
};
