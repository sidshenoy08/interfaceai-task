// In-memory "core banking" data store for the mock legacy target app.
// This is synthetic data only — no real PII, no real financial data.

export interface SubAccount {
  accountNumber: string;
  type: string;
  openedAt: string;
  initialDeposit: number;
}

export interface Member {
  id: string;
  name: string;
  status: "active" | "restricted";
  savingsBalance: number;
  checkingBalance: number;
  subAccounts: SubAccount[];
}

export const members = new Map<string, Member>([
  [
    "12345",
    {
      id: "12345",
      name: "John Smith",
      status: "active",
      savingsBalance: 4321.55,
      checkingBalance: 900.1,
      subAccounts: [],
    },
  ],
  [
    "67890",
    {
      id: "67890",
      name: "Jane Doe",
      status: "active",
      savingsBalance: 10234.0,
      checkingBalance: 512.4,
      subAccounts: [],
    },
  ],
  [
    "50000",
    {
      id: "50000",
      name: "Restricted Account Holder",
      status: "restricted",
      savingsBalance: 0,
      checkingBalance: 0,
      subAccounts: [],
    },
  ],
]);

let nextAccountNumber = 800001;
export function issueAccountNumber(): string {
  return String(nextAccountNumber++);
}
