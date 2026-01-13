import AbiContractUI from '@/components/AbiContractUI';
import { Suspense } from 'react';

export default function ContractPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-black via-zinc-900 to-black">
      <Suspense fallback={null}>
        <AbiContractUI />
      </Suspense>
    </main>
  );
}
