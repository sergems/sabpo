import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, CheckCircle2, ChevronDown, Mail, ShieldCheck, Sparkles, X } from "lucide-react";
import { getCountries, getCountryCallingCode, parsePhoneNumber, type Country } from "react-phone-number-input";
import countryFlags from "react-phone-number-input/flags";
import { calculateBpoEstimate, MONTHLY_HOURS, serviceOptions, type Currency } from "../../../shared/bpo-estimate";
import { beaconIntake, enqueueIntake, removeIntake } from "@/lib/calculator-outbox";

type LeadData = {
  firstName: string;
  surname: string;
  company: string;
  position: string;
  email: string;
  telephone: string;
};
type LeadDraft = LeadData & { website: string };
type Props = { onClose: () => void };
type LeadFieldErrors = Partial<Record<keyof LeadDraft | "consent", string>>;

const inclusions = [
  "Advisor salary, most competitive rates and commissions in Durban",
  "Dedicated Team Leader",
  "Operations Manager",
  "IT infrastructure and software",
  "Dell systems",
  "Microsoft",
  "Telephony platform",
  "Reporting Suites (Power BI)",
  "World-class facility and connectivity",
  "Three links routing across Africa to ensure 99.9% uptime",
  "All Tier 1 carriers",
  "Back-up power and water",
];

const formatCurrency = (amount: number, currency: Currency) => new Intl.NumberFormat(
  currency === "USD" ? "en-US" : "en-GB",
  { style: "currency", currency, minimumFractionDigits: 2, maximumFractionDigits: 2 },
).format(amount);

const emptyDraft: LeadDraft = {
  firstName: "",
  surname: "",
  company: "",
  position: "",
  email: "",
  telephone: "",
  website: "",
};

type CalculatorSession = {
  step: "lead" | "calculator";
  draft: LeadDraft;
  lead: LeadData | null;
  phoneCountry: Country;
  consent: boolean;
  previewOnly: boolean;
  currency: Currency;
  serviceId: string;
  advisors: number;
  moreThanThirty: boolean;
  largeAdvisorCount: string;
};

const SESSION_COOKIE_NAME = "sa_bpo_calculator_session";
const SESSION_STORAGE_PREFIX = "sa-bpo-calculator-session:";
const leadFields: (keyof LeadData)[] = ["firstName", "surname", "company", "position", "email", "telephone"];
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const leadFieldIds: Record<keyof LeadData | "consent", string> = {
  firstName: "bpo-first-name",
  surname: "bpo-surname",
  company: "bpo-company",
  position: "bpo-position",
  email: "bpo-company-email",
  telephone: "bpo-telephone",
  consent: "bpo-consent",
};
const countryNames = new Intl.DisplayNames(["en"], { type: "region" });
const phoneCountries = getCountries().map((country) => ({
  country,
  name: countryNames.of(country) ?? country,
  callingCode: getCountryCallingCode(country),
})).sort((left, right) => left.name.localeCompare(right.name));

function toInternationalTelephone(value: string, country: Country): string {
  const trimmed = value.trim();
  const parsed = trimmed.startsWith("+") ? parsePhoneNumber(trimmed) : parsePhoneNumber(trimmed, country);
  if (parsed) return parsed.number;

  const digits = trimmed.replace(/\D/g, "");
  const nationalDigits = trimmed.startsWith("+") ? digits : digits.replace(/^0+/, "");
  return `+${trimmed.startsWith("+") ? digits : `${getCountryCallingCode(country)}${nationalDigits}`}`;
}

function readSessionIdFromCookie(): string | null {
  if (typeof document === "undefined") return null;
  const prefix = `${SESSION_COOKIE_NAME}=`;
  const entry = document.cookie.split(";").map((cookie) => cookie.trim()).find((cookie) => cookie.startsWith(prefix));
  if (!entry) return null;
  try {
    const sessionId = decodeURIComponent(entry.slice(prefix.length));
    return /^[a-zA-Z0-9-]{1,80}$/.test(sessionId) ? sessionId : null;
  } catch {
    return null;
  }
}

function ensureSessionCookie(): string | null {
  if (typeof window === "undefined" || typeof document === "undefined") return null;
  const existingId = readSessionIdFromCookie();
  if (existingId) return existingId;
  const sessionId = window.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}; Path=/; SameSite=Lax${secure}`;
  return sessionId;
}

function clearCalculatorSession(): void {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  const sessionId = readSessionIdFromCookie();
  if (sessionId) {
    try {
      window.sessionStorage.removeItem(`${SESSION_STORAGE_PREFIX}${sessionId}`);
    } catch {
      // Keep the calculator usable if browser storage is unavailable.
    }
  }
  const secure = window.location.protocol === "https:" ? "; Secure" : "";
  document.cookie = `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax${secure}`;
}

function isLeadData(value: unknown): value is LeadData {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return leadFields.every((field) => typeof record[field] === "string");
}

function readCalculatorSession(): CalculatorSession | null {
  if (typeof window === "undefined") return null;
  const sessionId = readSessionIdFromCookie();
  if (!sessionId) return null;
  try {
    const savedText = window.sessionStorage.getItem(`${SESSION_STORAGE_PREFIX}${sessionId}`);
    if (!savedText) return null;
    const saved = JSON.parse(savedText) as Partial<CalculatorSession> | null;
    if (!saved || typeof saved !== "object" || saved.consent !== true || !saved.draft || typeof saved.draft !== "object") return null;

    const savedDraft = saved.draft as Partial<LeadDraft>;
    const draft: LeadDraft = { ...emptyDraft };
    for (const field of leadFields) {
      if (typeof savedDraft[field] === "string") draft[field] = savedDraft[field] as string;
    }
    const lead = isLeadData(saved.lead) ? saved.lead : null;
    const phoneCountry = typeof saved.phoneCountry === "string" && getCountries().includes(saved.phoneCountry as Country)
      ? saved.phoneCountry as Country
      : "ZA";
    const advisorValue = Number(saved.advisors);
    const serviceId = typeof saved.serviceId === "string" && serviceOptions.some((service) => service.id === saved.serviceId)
      ? saved.serviceId
      : serviceOptions[0].id;
    return {
      step: saved.step === "calculator" && lead ? "calculator" : "lead",
      draft,
      lead,
      phoneCountry,
      consent: true,
      previewOnly: saved.previewOnly === true,
      currency: saved.currency === "GBP" ? "GBP" : "USD",
      serviceId,
      advisors: Number.isFinite(advisorValue) ? Math.min(30, Math.max(1, Math.round(advisorValue))) : 12,
      moreThanThirty: saved.moreThanThirty === true,
      largeAdvisorCount: typeof saved.largeAdvisorCount === "string" && /^\d{1,4}$/.test(saved.largeAdvisorCount) ? saved.largeAdvisorCount : "31",
    };
  } catch {
    return null;
  }
}

export default function BpoCalculatorModal({ onClose }: Props) {
  const [sessionSeed] = useState(() => readCalculatorSession());
  const [step, setStep] = useState<"lead" | "calculator">(sessionSeed?.step ?? "lead");
  const [draft, setDraft] = useState<LeadDraft>(sessionSeed?.draft ?? emptyDraft);
  const [lead, setLead] = useState<LeadData | null>(sessionSeed?.lead ?? null);
  const [phoneCountry, setPhoneCountry] = useState<Country>(sessionSeed?.phoneCountry ?? "ZA");
  const [countryPickerOpen, setCountryPickerOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState("");
  const phoneCountryPickerRef = useRef<HTMLDivElement>(null);
  const closeCalculatorRef = useRef<() => void>(() => onClose());
  const latestPayloadRef = useRef<Record<string, unknown> | null>(null);
  const currentSubmissionIdRef = useRef<string | null>(null);
  const currentPayloadFingerprintRef = useRef<string | null>(null);
  const sentEstimateSnapshotRef = useRef<string | null>(null);
  const estimateRequestRef = useRef<Promise<boolean> | null>(null);
  const [consent, setConsent] = useState(sessionSeed?.consent ?? false);
  const [fieldErrors, setFieldErrors] = useState<LeadFieldErrors>({});
  const [estimateSending, setEstimateSending] = useState(false);
  const [estimateSendError, setEstimateSendError] = useState("");
  const [previewOnly, setPreviewOnly] = useState(sessionSeed?.previewOnly ?? false);
  const [currency, setCurrency] = useState<Currency>(sessionSeed?.currency ?? "USD");
  const [serviceId, setServiceId] = useState(sessionSeed?.serviceId ?? serviceOptions[0].id);
  const [advisors, setAdvisors] = useState(sessionSeed?.advisors ?? 12);
  const [moreThanThirty, setMoreThanThirty] = useState(sessionSeed?.moreThanThirty ?? false);
  const [largeAdvisorCount, setLargeAdvisorCount] = useState(sessionSeed?.largeAdvisorCount ?? "31");
  const selectedPhoneCountry = phoneCountries.find((option) => option.country === phoneCountry) ?? phoneCountries[0];
  const SelectedCountryFlag = countryFlags[phoneCountry];
  const filteredPhoneCountries = useMemo(() => {
    const query = countrySearch.trim().toLocaleLowerCase();
    if (!query) return phoneCountries;
    const digits = query.replace(/\D/g, "");
    return phoneCountries.filter((option) => option.name.toLocaleLowerCase().includes(query)
      || option.country.toLocaleLowerCase() === query
      || (digits.length > 0 && option.callingCode.includes(digits)));
  }, [countrySearch]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (countryPickerOpen) {
          setCountryPickerOpen(false);
          setCountrySearch("");
          return;
        }
        closeCalculatorRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose, countryPickerOpen]);

  useEffect(() => {
    if (!countryPickerOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!phoneCountryPickerRef.current?.contains(event.target as Node)) {
        setCountryPickerOpen(false);
        setCountrySearch("");
      }
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [countryPickerOpen]);

  useEffect(() => {
    if (!consent) return;
    try {
      const sessionId = ensureSessionCookie();
      if (!sessionId) return;
      const session: CalculatorSession = { step, draft, lead, phoneCountry, consent: true, previewOnly, currency, serviceId, advisors, moreThanThirty, largeAdvisorCount };
      window.sessionStorage.setItem(`${SESSION_STORAGE_PREFIX}${sessionId}`, JSON.stringify(session));
    } catch {
      // Session persistence is an enhancement; the calculator remains usable without browser storage.
    }
  }, [step, draft, lead, phoneCountry, consent, previewOnly, currency, serviceId, advisors, moreThanThirty, largeAdvisorCount]);

  useEffect(() => {
    if (!consent) {
      latestPayloadRef.current = null;
      currentSubmissionIdRef.current = null;
      currentPayloadFingerprintRef.current = null;
      return;
    }
    const draftLead: LeadData = {
      firstName: draft.firstName.trim(),
      surname: draft.surname.trim(),
      company: draft.company.trim(),
      position: draft.position.trim(),
      email: draft.email.trim().toLowerCase(),
      telephone: draft.telephone.trim() ? toInternationalTelephone(draft.telephone, phoneCountry) : "",
    };
    const hasRequiredDetails = [draftLead.firstName, draftLead.surname, draftLead.company, draftLead.position, draftLead.email].every(Boolean)
      && emailPattern.test(draftLead.email);
    if (!hasRequiredDetails) {
      latestPayloadRef.current = null;
      currentSubmissionIdRef.current = null;
      currentPayloadFingerprintRef.current = null;
      return;
    }
    const nextPayload: Record<string, unknown> = {
      ...(lead ?? draftLead),
      consent: true,
      website: draft.website,
      ...(lead ? { calculator: { serviceId, currency, advisorCount: moreThanThirty ? Math.min(1000, Math.max(31, Math.round(Number(largeAdvisorCount) || 31))) : advisors, moreThanThirty } } : {}),
    };
    const fingerprint = JSON.stringify(nextPayload);
    if (fingerprint !== currentPayloadFingerprintRef.current) {
      currentPayloadFingerprintRef.current = fingerprint;
      currentSubmissionIdRef.current = null;
    }
    latestPayloadRef.current = {
      ...nextPayload,
      ...(currentSubmissionIdRef.current ? { submissionId: currentSubmissionIdRef.current } : {}),
    };
  }, [consent, draft, lead, phoneCountry, serviceId, currency, advisors, moreThanThirty, largeAdvisorCount]);

  useEffect(() => {
    const handlePageHide = () => {
      const payload = latestPayloadRef.current;
      if (payload && !previewOnly) beaconIntake(payload);
    };
    window.addEventListener("pagehide", handlePageHide);
    return () => window.removeEventListener("pagehide", handlePageHide);
  }, [previewOnly]);

  const advisorCount = moreThanThirty ? Math.min(1000, Math.max(31, Math.round(Number(largeAdvisorCount) || 31))) : advisors;
  const { selectedService, hourlyRate, monthlyPerAdvisor, monthlyTotal, tierLabel } = calculateBpoEstimate(currency, serviceId, advisorCount);

  const emailDraft = useMemo(() => {
    if (!lead) return "";
    const subject = `BPO calculator estimate — ${lead.company}`;
    const lines = [
      "Hello SA-BPO team,",
      "",
      "I would like to discuss this indicative BPO calculator estimate:",
      "",
      `Name: ${lead.firstName} ${lead.surname}`,
      `Company: ${lead.company}`,
      `Position: ${lead.position}`,
      `Company email: ${lead.email}`,
      `Telephone: ${lead.telephone}`,
      "",
      `Service focus: ${selectedService.label}`,
      `Advisors required: ${advisorCount}`,
      `More than 30 advisors selected: ${moreThanThirty ? "Yes" : "No"}`,
      `Currency: ${currency}`,
      `Rate tier: ${tierLabel}`,
      `Hourly rate per advisor: ${formatCurrency(hourlyRate, currency)}`,
      `Monthly rate per advisor: ${formatCurrency(monthlyPerAdvisor, currency)}`,
      `Total indicative monthly invoice: ${formatCurrency(monthlyTotal, currency)}`,
      "Working assumptions: 9 hours per day, 45 hours per week, 195 working hours per month.",
      ...(moreThanThirty ? ["For 31+ advisors, the estimate uses the 25–30 advisor base rate. The SA-BPO team will follow up within 48 hours to discuss the requirements."] : []),
      "",
      "These prices are indicative. SA-BPO will gather more information to prepare a tailored quote.",
    ];
    return `mailto:partnerships@sa-bpo.co.za?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(lines.join("\n"))}`;
  }, [lead, selectedService.label, advisorCount, currency, tierLabel, hourlyRate, monthlyPerAdvisor, monthlyTotal, moreThanThirty]);

  const updateDraft = (field: keyof LeadDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }));
    setFieldErrors((current) => ({ ...current, [field]: undefined }));
  };

  const submitLead = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleanLead: LeadData = {
      firstName: draft.firstName.trim(),
      surname: draft.surname.trim(),
      company: draft.company.trim(),
      position: draft.position.trim(),
      email: draft.email.trim().toLowerCase(),
      telephone: draft.telephone.trim() ? toInternationalTelephone(draft.telephone, phoneCountry) : "",
    };
    const phoneDigits = cleanLead.telephone.replace(/\D/g, "");
    const errors: LeadFieldErrors = {};
    const requiredFields: [keyof LeadData, string][] = [
      ["firstName", "Name"],
      ["surname", "Surname"],
      ["company", "Company"],
      ["position", "Position"],
      ["email", "Company email"],
    ];
    for (const [field, label] of requiredFields) {
      if (!cleanLead[field]) errors[field] = `${label} is required.`;
    }
    if (cleanLead.email && !emailPattern.test(cleanLead.email)) {
      errors.email = "Enter a valid company email address.";
    }
    if (draft.telephone.trim() && (phoneDigits.length < 7 || phoneDigits.length > 15)) {
      errors.telephone = "Enter a valid telephone number with 7 to 15 digits.";
    }
    if (!consent) {
      errors.consent = "Please agree to the data-use terms before continuing.";
    }

    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      const firstInvalidField = Object.keys(errors)[0] as keyof LeadData | "consent";
      document.getElementById(leadFieldIds[firstInvalidField])?.focus();
      return;
    }

    setLead(cleanLead);
    setStep("calculator");
  };

  const sendIntakeSnapshot = async (payload: Record<string, unknown>, sendCopyToCustomer = false): Promise<boolean> => {
    if (previewOnly) {
      if (sendCopyToCustomer) setEstimateSendError("Calculator submission cannot be sent from this local preview because email delivery is not configured.");
      return !sendCopyToCustomer;
    }
    const requestPayload = enqueueIntake({ ...payload, sendCopyToCustomer });
    currentSubmissionIdRef.current = requestPayload.submissionId;
    if (latestPayloadRef.current) latestPayloadRef.current = { ...latestPayloadRef.current, submissionId: requestPayload.submissionId };
    const snapshot = JSON.stringify(requestPayload);
    if (sentEstimateSnapshotRef.current === snapshot) return true;
    if (estimateRequestRef.current) return estimateRequestRef.current;

    setEstimateSending(true);
    setEstimateSendError("");
    const request = (async () => {
      try {
        const response = await fetch("/api/calculator-intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(requestPayload),
        });
        const result = await response.json().catch(() => ({})) as { error?: string };
        if (!response.ok && import.meta.env.DEV && response.status === 503) {
          setPreviewOnly(true);
          if (sendCopyToCustomer) {
            setEstimateSendError("Calculator submission cannot be sent from this local preview because email delivery is not configured.");
            return false;
          }
          removeIntake(requestPayload.submissionId);
          sentEstimateSnapshotRef.current = snapshot;
          return true;
        }
        if (!response.ok) throw new Error(result.error || "We couldn't send your estimate selections.");
        removeIntake(requestPayload.submissionId);
        sentEstimateSnapshotRef.current = snapshot;
        return true;
      } catch {
        setEstimateSendError("We couldn't send your calculator selections to SA-BPO. Please try again or use the compose button to send the estimate yourself.");
        return false;
      } finally {
        setEstimateSending(false);
        estimateRequestRef.current = null;
      }
    })();
    estimateRequestRef.current = request;
    return request;
  };

  const sendEstimateSnapshot = (sendCopyToCustomer = false): Promise<boolean> => {
    if (!lead) return Promise.resolve(true);
    const calculator = { serviceId, currency, advisorCount, moreThanThirty };
    return sendIntakeSnapshot({ ...lead, consent, website: draft.website, calculator }, sendCopyToCustomer);
  };

  const submitCompletedEstimate = async () => {
    const sent = await sendEstimateSnapshot(true);
    if (!sent) return;
    clearCalculatorSession();
    onClose();
  };

  const sendLeadOnlySnapshot = (): Promise<boolean> => {
    if (!consent || draft.website.trim()) return Promise.resolve(true);
    const leadFromDraft: LeadData = {
      firstName: draft.firstName.trim(),
      surname: draft.surname.trim(),
      company: draft.company.trim(),
      position: draft.position.trim(),
      email: draft.email.trim().toLowerCase(),
      telephone: draft.telephone.trim() ? toInternationalTelephone(draft.telephone, phoneCountry) : "",
    };
    const phoneDigits = leadFromDraft.telephone.replace(/\D/g, "");
    const requiredDetails = [leadFromDraft.firstName, leadFromDraft.surname, leadFromDraft.company, leadFromDraft.position, leadFromDraft.email];
    const hasValidTelephone = !leadFromDraft.telephone || (phoneDigits.length >= 7 && phoneDigits.length <= 15);
    if (requiredDetails.some((detail) => !detail) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(leadFromDraft.email) || !hasValidTelephone) {
      return Promise.resolve(true);
    }
    return sendIntakeSnapshot({ ...leadFromDraft, consent, website: draft.website });
  };

  const closeCalculator = async () => {
    if (step === "calculator" && lead && !previewOnly) {
      const sent = await sendEstimateSnapshot();
      if (!sent) return;
    } else if (step === "lead" && !previewOnly) {
      const sent = await sendLeadOnlySnapshot();
      if (!sent) return;
    }
    clearCalculatorSession();
    onClose();
  };
  closeCalculatorRef.current = () => { void closeCalculator(); };

  return (
    <div className="modal-backdrop bpo-calculator-backdrop" onClick={() => closeCalculatorRef.current()}>
      <section className="calculator-modal bpo-calculator-modal" role="dialog" aria-modal="true" aria-labelledby="bpo-calculator-title" onClick={(event) => event.stopPropagation()}>
        <button className="modal-close" onClick={() => closeCalculatorRef.current()} aria-label="Close BPO calculator" disabled={estimateSending}><X /></button>
        <div className="calculator-modal-body bpo-calculator-body">
          {step === "lead" ? (
            <>
              <p className="modal-kicker"><Sparkles size={15} aria-hidden="true" /> BPO calculator <span className="bpo-step-count">01 / 02</span></p>
              <h2 id="bpo-calculator-title" className="calculator-modal-title">Start with a <em>clear picture.</em></h2>
              <p className="bpo-calculator-intro">First, tell us who you are. After you give consent, your details are sent to SA-BPO if you close the calculator. If you submit a completed estimate, a copy is also sent to your company email.</p>
              <form className="bpo-intake-form" onSubmit={submitLead} noValidate>
                <div className="bpo-intake-grid">
                  <label htmlFor="bpo-first-name"><span>Name <small className="bpo-required-indicator">Required</small></span><input id="bpo-first-name" name="firstName" autoComplete="given-name" value={draft.firstName} onChange={(event) => updateDraft("firstName", event.target.value)} maxLength={80} required autoFocus aria-invalid={Boolean(fieldErrors.firstName)} aria-describedby={fieldErrors.firstName ? "bpo-first-name-error" : undefined} />{fieldErrors.firstName && <span className="bpo-field-error" id="bpo-first-name-error" role="alert">{fieldErrors.firstName}</span>}</label>
                  <label htmlFor="bpo-surname"><span>Surname <small className="bpo-required-indicator">Required</small></span><input id="bpo-surname" name="surname" autoComplete="family-name" value={draft.surname} onChange={(event) => updateDraft("surname", event.target.value)} maxLength={80} required aria-invalid={Boolean(fieldErrors.surname)} aria-describedby={fieldErrors.surname ? "bpo-surname-error" : undefined} />{fieldErrors.surname && <span className="bpo-field-error" id="bpo-surname-error" role="alert">{fieldErrors.surname}</span>}</label>
                  <label htmlFor="bpo-company"><span>Company <small className="bpo-required-indicator">Required</small></span><input id="bpo-company" name="company" autoComplete="organization" value={draft.company} onChange={(event) => updateDraft("company", event.target.value)} maxLength={120} required aria-invalid={Boolean(fieldErrors.company)} aria-describedby={fieldErrors.company ? "bpo-company-error" : undefined} />{fieldErrors.company && <span className="bpo-field-error" id="bpo-company-error" role="alert">{fieldErrors.company}</span>}</label>
                  <label htmlFor="bpo-position"><span>Position <small className="bpo-required-indicator">Required</small></span><input id="bpo-position" name="position" autoComplete="organization-title" value={draft.position} onChange={(event) => updateDraft("position", event.target.value)} maxLength={100} required aria-invalid={Boolean(fieldErrors.position)} aria-describedby={fieldErrors.position ? "bpo-position-error" : undefined} />{fieldErrors.position && <span className="bpo-field-error" id="bpo-position-error" role="alert">{fieldErrors.position}</span>}</label>
                  <label htmlFor="bpo-company-email"><span>Company email <small className="bpo-required-indicator">Required</small></span><input id="bpo-company-email" name="email" type="email" autoComplete="email" value={draft.email} onChange={(event) => updateDraft("email", event.target.value)} maxLength={254} required aria-invalid={Boolean(fieldErrors.email)} aria-describedby={fieldErrors.email ? "bpo-company-email-error" : undefined} />{fieldErrors.email && <span className="bpo-field-error" id="bpo-company-email-error" role="alert">{fieldErrors.email}</span>}</label>
                  <div className="bpo-phone-field"><label htmlFor="bpo-telephone"><span>Telephone number <small className="bpo-required-indicator">Optional</small></span></label><div className="bpo-phone-control"><div className="bpo-country-picker" ref={phoneCountryPickerRef}>
                    <button className="bpo-country-trigger" type="button" aria-label={`Choose country flag; selected ${selectedPhoneCountry.name}, +${selectedPhoneCountry.callingCode}`} aria-expanded={countryPickerOpen} aria-haspopup="dialog" onClick={() => { setCountrySearch(""); setCountryPickerOpen((open) => !open); }}>{SelectedCountryFlag && <SelectedCountryFlag title="" />}<ChevronDown size={12} aria-hidden="true" /></button>
                    {countryPickerOpen && <div className="bpo-country-popover" role="dialog" aria-label="Choose a country flag"><input className="bpo-country-search" type="search" placeholder="Search flags or calling code" aria-label="Search countries by name or calling code" value={countrySearch} onChange={(event) => setCountrySearch(event.target.value)} autoFocus /><div className="bpo-country-flag-grid" role="group" aria-label="Available country flags" onKeyDown={(event) => { if (!["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) return; const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>(".bpo-country-flag-option")); const currentIndex = buttons.indexOf(document.activeElement as HTMLButtonElement); if (currentIndex < 0 || buttons.length === 0) return; event.preventDefault(); const direction = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1; buttons[(currentIndex + direction + buttons.length) % buttons.length]?.focus(); }}>{filteredPhoneCountries.map((option, index) => {
                      const CountryFlag = countryFlags[option.country];
                      return <button className={`bpo-country-flag-option${option.country === phoneCountry ? " is-selected" : ""}`} type="button" key={option.country} aria-label={`${option.name}, +${option.callingCode}`} aria-pressed={option.country === phoneCountry} tabIndex={index === 0 ? 0 : -1} onClick={() => { setPhoneCountry(option.country); setCountryPickerOpen(false); setCountrySearch(""); setFieldErrors((current) => ({ ...current, telephone: undefined })); }}>{CountryFlag && <CountryFlag title="" />}</button>;
                    })}</div>{filteredPhoneCountries.length === 0 && <p className="bpo-country-empty">No matching flags.</p>}</div>}
                  </div><span className="bpo-phone-prefix">+{getCountryCallingCode(phoneCountry)}</span><input id="bpo-telephone" name="telephone" type="tel" autoComplete="tel-national" inputMode="tel" placeholder="Phone number" value={draft.telephone} onChange={(event) => updateDraft("telephone", event.target.value)} maxLength={30} aria-invalid={Boolean(fieldErrors.telephone)} aria-describedby={fieldErrors.telephone ? "bpo-telephone-error" : undefined} /></div>{fieldErrors.telephone && <span className="bpo-field-error" id="bpo-telephone-error" role="alert">{fieldErrors.telephone}</span>}</div>
                </div>
                <label className="bpo-honeypot" aria-hidden="true">Leave this field empty<input name="website" tabIndex={-1} autoComplete="off" value={draft.website} onChange={(event) => updateDraft("website", event.target.value)} /></label>
                <label className="bpo-consent"><input type="checkbox" checked={consent} onChange={(event) => {
                  const optedIn = event.target.checked;
                  setConsent(optedIn);
                  if (optedIn) setFieldErrors((current) => ({ ...current, consent: undefined }));
                  if (!optedIn) clearCalculatorSession();
                }} id="bpo-consent" required aria-invalid={Boolean(fieldErrors.consent)} aria-describedby={fieldErrors.consent ? "bpo-consent-error" : undefined} /><span>I agree that SA-BPO may use my details and calculator selections to prepare and respond to this estimate. If I submit the completed calculator, a copy will also be sent to my company email.</span></label>
                {fieldErrors.consent && <p className="bpo-field-error" id="bpo-consent-error" role="alert">{fieldErrors.consent}</p>}
                {estimateSendError && <p className="bpo-form-error" role="alert">{estimateSendError}</p>}
                <button className="button button--green button--full bpo-submit-button" type="submit">
                  Continue to calculator <ArrowRight size={17} />
                </button>
              </form>
            </>
          ) : (
            <>
              <p className="modal-kicker"><CheckCircle2 size={15} aria-hidden="true" /> Details validated <span className="bpo-step-count">02 / 02</span></p>
              <div className={`bpo-calculator-welcome${previewOnly ? " bpo-calculator-welcome--preview" : ""}`}><div><p className="bpo-welcome-label">Welcome</p><h2 id="bpo-calculator-title">{lead?.firstName}, let's shape your <em>first estimate.</em></h2></div></div>
              <div className="bpo-calculator-controls">
                <label className="bpo-service-picker" htmlFor="bpo-service-focus">Service focus
                  <select className="bpo-service-select" id="bpo-service-focus" name="bpo-service" value={serviceId} disabled={estimateSending} onChange={(event) => setServiceId(event.target.value)}>
                    {serviceOptions.map((service) => <option key={service.id} value={service.id}>{service.label}</option>)}
                  </select>
                  <small className="bpo-service-help">Select a service focus from the dropdown to view its estimate.</small>
                </label>
                <div className="bpo-calc-settings">
                  <fieldset className="bpo-currency-fieldset"><legend>Currency</legend><div className="bpo-currency-switch">
                    {(["USD", "GBP"] as const).map((option) => <label className={currency === option ? "is-selected" : ""} key={option}><input type="radio" name="bpo-currency" value={option} checked={currency === option} disabled={estimateSending} onChange={() => setCurrency(option)} /><span>{option === "USD" ? "$ USD" : "£ GBP"}</span></label>)}
                  </div></fieldset>
                  <div className="bpo-advisor-control"><label htmlFor="bpo-advisor-range">Advisors required for launch <output>{moreThanThirty ? `${advisorCount}+` : advisors}</output></label><input id="bpo-advisor-range" type="range" min="1" max="30" value={advisors} disabled={moreThanThirty || estimateSending} onChange={(event) => setAdvisors(Number(event.target.value))} /><div className="bpo-range-labels"><span>1 advisor</span><span>30 advisors</span></div></div>
                  <label className="bpo-over-thirty"><input type="checkbox" checked={moreThanThirty} disabled={estimateSending} onChange={(event) => setMoreThanThirty(event.target.checked)} /><span>I need more than 30 advisors</span></label>
                  {moreThanThirty && <label className="bpo-large-count" htmlFor="bpo-large-advisors">Advisor count<input id="bpo-large-advisors" type="number" min={31} max={1000} step={1} value={largeAdvisorCount} disabled={estimateSending} onChange={(event) => setLargeAdvisorCount(event.target.value)} onBlur={() => setLargeAdvisorCount(String(Math.min(1000, Math.max(31, Math.round(Number(largeAdvisorCount) || 31)))))} /></label>}
                </div>
              </div>
              <section className="bpo-estimate" aria-live="polite" aria-labelledby="bpo-estimate-heading">
                <div className="bpo-estimate-heading"><div><p>Indicative estimate for {lead?.firstName}</p><h3 id="bpo-estimate-heading">{selectedService.label}</h3></div><span className="bpo-tier-badge">{tierLabel}</span></div>
                <div className="bpo-estimate-metrics">
                  <div><span>Hourly rate / advisor</span><strong>{formatCurrency(hourlyRate, currency)}</strong></div>
                  <div><span>Monthly rate / advisor</span><strong>{formatCurrency(monthlyPerAdvisor, currency)}</strong></div>
                  <div className="bpo-estimate-total"><span>Total monthly invoice</span><strong>{formatCurrency(monthlyTotal, currency)}</strong><small>{advisorCount} advisor{advisorCount === 1 ? "" : "s"} × {formatCurrency(monthlyPerAdvisor, currency)}</small></div>
                </div>
                <div className="bpo-hours-note"><ShieldCheck size={17} aria-hidden="true" /><span>Based on <strong>9 hours per day</strong>, <strong>45 hours per week</strong>, and <strong>195 working hours per month</strong>.</span></div>
                {moreThanThirty && <p className="bpo-large-team-note">For more than 30 advisors, this estimate uses the 25–30 advisor base rate. Our team will be in touch within the next 48 hours to discuss your requirements.</p>}
              </section>
              <details className="bpo-inclusions"><summary>What is included in the rate?</summary><ul>{inclusions.map((item) => <li key={item}>{item}</li>)}</ul></details>
              <p className="bpo-disclaimer">These prices are indicative and intended to provide an initial guide. Our associates will gather more information to create a tailored quote for your business requirements.</p>
              <div className="bpo-result-actions">
                <div className="bpo-result-actions__main">
                  {estimateSending && <p className="bpo-form-status" role="status">Sending your completed estimate to SA-BPO and preparing your copy…</p>}
                  {estimateSendError && <p className="bpo-form-error" role="alert">{estimateSendError}</p>}
                  <button className="button button--green button--full" type="button" disabled={estimateSending} onClick={() => { void submitCompletedEstimate(); }}>Submit calculator <ArrowRight size={17} /></button>
                  <a className="button bpo-compose-email-button button--full" href={emailDraft} aria-disabled={estimateSending} onClick={(event) => { if (estimateSending) { event.preventDefault(); return; } void sendEstimateSnapshot(); }}><Mail size={17} /> Compose estimate email <ArrowRight size={17} /></a>
                </div>
                <button className="bpo-close-button" type="button" onClick={() => { void closeCalculator(); }} disabled={estimateSending}>{estimateSending ? "Sending estimate…" : "Close calculator"}</button>
              </div>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
