import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewRecordForm from '@/components/doctor/NewRecordForm';
import { createRecord, fetchRecords } from '@/services/api.service';
import { useWalletStore } from '@/store/useWalletStore';
import { enqueueClinicalRecord, listClinicalOutbox } from '@/lib/clinicalOutbox';

jest.mock('@/services/api.service', () => ({
  createRecord: jest.fn(),
  fetchRecords: jest.fn(),
}));

jest.mock('@/lib/clinicalOutbox', () => ({
  enqueueClinicalRecord: jest.fn(),
  listClinicalOutbox: jest.fn(),
  removeClinicalOutboxItem: jest.fn(),
  setClinicalOutboxStatus: jest.fn(),
}));

const mockCreateRecord = createRecord as jest.MockedFunction<typeof createRecord>;
const mockFetchRecords = fetchRecords as jest.MockedFunction<typeof fetchRecords>;
const mockEnqueue = enqueueClinicalRecord as jest.MockedFunction<typeof enqueueClinicalRecord>;
const mockList = listClinicalOutbox as jest.MockedFunction<typeof listClinicalOutbox>;

describe('NewRecordForm offline outbox', () => {
  const originalOnLine = navigator.onLine;

  beforeEach(() => {
    jest.clearAllMocks();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    useWalletStore.setState({ publicKey: 'GDOCTOR', role: 'DOCTOR' });
    mockFetchRecords.mockResolvedValue([]);
    mockEnqueue.mockResolvedValue('offline-record-1');
    mockList.mockResolvedValue([]);
  });

  afterAll(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: originalOnLine });
  });

  it('encrypts to the outbox instead of posting while offline, then shows its status', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={queryClient}>
        <NewRecordForm patientAddress="GPATIENT" onSuccess={jest.fn()} />
      </QueryClientProvider>,
    );

    fireEvent.change(screen.getByPlaceholderText('e.g. Acute Bacterial Sinusitis, Hypertension'), {
      target: { value: 'Hypertension' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Record' }));

    await waitFor(() =>
      expect(mockEnqueue).toHaveBeenCalledWith(
        'GDOCTOR',
        expect.objectContaining({
          patientAddress: 'GPATIENT',
          diagnosis: 'Hypertension',
        }),
      ),
    );
    expect(mockCreateRecord).not.toHaveBeenCalled();
    expect(await screen.findByRole('dialog', { name: 'Clinical outbox' })).toBeInTheDocument();
    queryClient.clear();
  });
});
