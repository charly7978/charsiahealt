---
name: "architecture-guardian"
description: "Enforces architectural integrity and medical auditing standards. Invoke when reviewing health-critical code, DSP pipelines, or auditing medical compliance."
---

# Architecture Guardian

This skill is designed to act as a rigorous auditor for health-critical software systems. It focuses on:

1.  **Architectural Integrity**: Ensuring that the system follows robust design patterns (Clean Architecture, SOLID, Hexagonal) suitable for medical applications.
2.  **Medical Auditing**: Validating that Signal Processing (DSP) pipelines, PPG/rPPG algorithms, and vital sign computations adhere to scientific literature (Nature, IEEE) and safety standards.
3.  **No-Simulation Policy**: Strict enforcement of real-data processing, ensuring no placeholders or simulated health data are used in production-grade code.
4.  **Security & Compliance**: Verifying telemetry (App Insights) and Azure infrastructure readiness for sensitive health data.

## When to Invoke
- Before merging any changes to `src/modules` (DSP/Health logic).
- When auditing the repository for medical validation.
- When ensuring the system is ready for production deployment on Azure.
