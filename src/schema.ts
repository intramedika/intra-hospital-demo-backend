// src/schema.ts
// Production-ready GraphQL SDL — Intramedika Assistive AI (OCI Speech + LLM)
// ✅ Dashboard FULL aligns with DashboardTab (FE)
// ✅ Enum-based source for SOAP (safer than free-form string)
// ✅ Backward compatible assistiveChat: String!
// ✅ Future-safe assistiveChatV2: AssistiveChatResult!

import { parse } from "graphql";

export const typeDefs = parse(/* GraphQL */ `
  """
  Root Query
  """
  type Query {
    """
    Healthcheck endpoint
    """
    _health: String!

    """
    Get patient by ID
    """
    patient(id: ID!): Patient

    """
    Lab summary for encounter
    """
    labSummary(encounterId: String!): [LabItem!]!

    """
    Unit dashboard (multi-patient)
    """
    dashboard(unitId: String!): Dashboard!
  }

  """
  Master Patient (minimal fields for widget)
  """
  type Patient {
    id: ID!
    name: String!
    mrn: String
    careUnit: String
    attendingDoctor: String
    attendingDoctorSip: String
  }

  """
  Lab summary item (minimal)
  """
  type LabItem {
    id: ID!
    testName: String!
    value: String
    unit: String
    flag: String
    date: String
  }

  """
  Dashboard KPI metrics
  """
  type DashboardKpis {
    occupancyRate: Float!
    losAverage: Float!
    staffAvailability: Float!
    activeAlerts: Int!
  }

  """
  External services monitored by Command Center
  """
  enum ExternalServiceStatus {
    ONLINE
    LATENCY
    OFFLINE
  }

  enum TrendDirection {
    STABLE
    RISING
    FALLING
  }

  type ExternalServiceStatusItem {
    name: String!
    status: ExternalServiceStatus!
    latencyMs: Int!
    trend: TrendDirection!
  }

  """
  Resources & inventory
  """
  enum ResourceCategory {
    BEDS
    DEVICE
    MEDS
    CONSUMABLE
    OTHER
  }

  enum ResourceStatus {
    OK
    WARNING
    CRITICAL
  }

  type ResourceItem {
    name: String!
    category: ResourceCategory!
    currentStock: Int!
    totalCapacity: Int!
    unit: String!
    status: ResourceStatus!
  }

  """
  Queue monitor
  """
  enum QueueTrend {
    STABLE
    INCREASING
    DECREASING
  }

  type QueueItem {
    location: String!
    currentQueueLength: Int!
    estimatedWaitTimeMinutes: Int!
    predictionTrend: QueueTrend!
  }

  """
  Patient row shown in DashboardTab
  """
  enum RiskLevel {
    LOW
    MEDIUM
    HIGH
    CRITICAL
  }

  type DashboardPatient {
    id: ID!
    name: String!
    mrn: String
    room: String
    riskScore: Int!
    riskLevel: RiskLevel!
    aiPrediction: String
    aiAction: String
    diagnosis: String
  }

  """
  Unit dashboard (FULL)
  - Aligns with frontend DashboardMultiPatient model.
  """
  type Dashboard {
    unitId: String!
    unitName: String!

    kpis: DashboardKpis!
    growthInsights: [String!]!

    externalServices: [ExternalServiceStatusItem!]!
    resources: [ResourceItem!]!
    queues: [QueueItem!]!
    patients: [DashboardPatient!]!
  }

  """
  SOAP Note (LLM generated)
  """
  enum SoapSource {
    GENAI
    SPEECH_GENAI
    MANUAL
    OFFLINE
  }

  type SoapNote {
    encounterId: String!
    subjective: String!
    objective: String!
    assessment: String!
    plan: String!

    """
    Source of generation:
    - GENAI: from text transcript
    - SPEECH_GENAI: from audio -> speech -> genai
    - OFFLINE: fallback/safe mode
    - MANUAL: reserved
    """
    source: SoapSource
  }

  """
  Assistive chat structured result (future-safe)
  """
  type AssistiveChatResult {
    message: String!
    source: String
  }

  """
  Supported audio formats for speech-to-text
  """
  enum AudioFormat {
    WEBM
    WAV
    M4A
    MP3
    OGG
  }

  """
  Root Mutation
  """
  type Mutation {
    """
    TEXT → SOAP
    """
    formSOAPTranscript(voiceInput: String!, patientId: String!): SoapNote!

    """
    AUDIO(base64) → OCI Speech → SOAP
    """
    formSOAPFromAudio(
      audioBase64: String!
      format: AudioFormat = WEBM
      patientId: String!
    ): SoapNote!

    """
    Assistive chat (used by AssistiveTab)

    NOTE:
    - FE saat ini mengharapkan return type String
    """
    assistiveChat(prompt: String!, patientId: String, contextText: String): String!

    """
    Future-safe version (optional migration)
    """
    assistiveChatV2(prompt: String!, patientId: String, contextText: String): AssistiveChatResult!
  }
`);
