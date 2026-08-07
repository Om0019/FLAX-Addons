<div align="center">
  <br />
  <h1>🌟 FLAX-Addons</h1>
  <p>
    <strong>A high-performance collection of media scrapers and streaming addons for FLAX.</strong>
  </p>
  <br />

  <p>
    <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-v20+-green.svg?style=flat-square&logo=node.js" alt="Node.js version"></a>
    <a href="https://expressjs.com"><img src="https://img.shields.io/badge/Express-v5.2.1-lightgrey.svg?style=flat-square&logo=express" alt="Express version"></a>
    <a href="#license"><img src="https://img.shields.io/badge/License-ISC-blue.svg?style=flat-square" alt="License"></a>
  </p>
</div>

<hr />

## 📖 Overview

**FLAX-Addons** (formerly known as Latino Addon) is a robust Node.js backend providing media streaming links from a wide array of sources. It comes equipped with a comprehensive suite of scrapers designed for high reliability, fast response times, and resilience. 

This repository houses multiple addons:
- 🌍 **Latino Addon**: A rich set of scrapers targeting popular Spanish-language streaming sites (e.g., *Cuevana, PelisPedia, CineCalidad, SoloLatino, Tlnovelas, etc.*).
- 🇬🇧 **English Addon**: A dedicated sub-module for scraping high-quality English media sources.
- 📦 **Nuvio Addon**: Integrations for Nuvio compatibility.

---

## ✨ Features

- ⚡️ **High-Performance Scraping**: Built with `cheerio` for blazing fast HTML parsing without browser overhead.
- 🛡️ **Built-in SSRF & Network Guards**: Strict networking rules and proxy stream guards to protect the host.
- 🧪 **Extensive Testing Suite**: Heavily tested with comprehensive unit/integration tests for host reliability, search latency, and playback regressions.
- 🚀 **Express Driven**: Lightweight HTTP server infrastructure using `express` v5.
- 🧠 **Smart Caching**: In-memory TTL caching to optimize frequent queries and reduce external load.

---

## 🛠️ Prerequisites

- **Node.js**: `v20.0.0` or higher is required.
- **NPM**: `v9.0.0` or higher.

---

## 🚀 Installation & Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/Om0019/FLAX-Addons.git
   cd FLAX-Addons
   ```

2. **Install dependencies:**
   This will install dependencies for the root project and automatically run the `postinstall` script to install dependencies for the `english-addon`.
   ```bash
   npm install
   ```

3. **Start the server:**
   ```bash
   npm start
   ```
   The server will boot up and begin listening for API queries!

---

## 🏗️ Project Structure

```text
FLAX-Addons/
├── src/                # Core logic, server setup, and scraper implementations
│   ├── scrapers/       # Individual site scrapers (CineCalidad, Cuevana, etc.)
│   └── ...             # Helpers, caching, HTTP utils
├── english-addon/      # Sub-module for English content scrapers
├── nuvio-addon/        # Sub-module for Nuvio compatibility
├── test_*.js           # Extensive testing files for quality, latency, and reliability
├── index.js            # Main application entry point
└── package.json        # Project metadata and scripts
```

---

## 🧪 Testing

We take reliability seriously. FLAX-Addons includes an exhaustive test suite to ensure scrapers remain functional when target sites change.

To run the complete test suite (includes syntax checks, unit tests, and the `english-addon` tests):

```bash
npm test
```

**Specific Test Commands:**
- `npm run test:wrappers` - Test host wrapper implementations
- `npm run test:smoke` - Quick smoke test to ensure core functionality
- `npm run test:hosts` - Check host reliability and uptime

---

## 📄 License

This project is licensed under the **ISC License**. See the `package.json` for details.
