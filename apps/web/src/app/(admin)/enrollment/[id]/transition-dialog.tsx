'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@sms/ui';
import { LEGAL_STATUS_TRANSITIONS, transitionEnrollmentStatus, type Enrollment, type EnrollmentStatus } from '../../../../lib/api';
import { ENROLLMENT_STATUS_LABELS } from '../format';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export interface TransitionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  enrollment: Enrollment;
}

/**
 * Offers only the transitions `LEGAL_STATUS_TRANSITIONS` allows from the
 * enrolment's current status - e.g. nothing at all from "graduated" or
 * "transferred_out" (both terminal). This is a UX convenience, not the
 * enforcement point: `EnrollmentRecordService.transitionStatus` re-checks
 * `isLegalStatusTransition` server-side regardless of what this dialog
 * offered, so a stale client can only under-offer, never push through an
 * illegal transition.
 */
export function TransitionDialog({ open, onOpenChange, enrollment }: TransitionDialogProps) {
  const queryClient = useQueryClient();
  const legalNextStatuses = LEGAL_STATUS_TRANSITIONS[enrollment.status];

  const [toStatus, setToStatus] = React.useState<EnrollmentStatus | ''>('');
  const [effectiveOn, setEffectiveOn] = React.useState(today());
  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setToStatus('');
      setEffectiveOn(today());
      setReason('');
    }
  }, [open]);

  const transitionMutation = useMutation({
    mutationFn: () => {
      if (!toStatus) throw new Error('Choose a status to transition to.');
      return transitionEnrollmentStatus(enrollment.id, {
        toStatus,
        effectiveOn,
        reason: reason.trim() || undefined,
      });
    },
    onSuccess: (updated) => {
      toast.success('Status updated', {
        description: `Now ${ENROLLMENT_STATUS_LABELS[updated.status]}, effective ${effectiveOn}.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['enrollment', 'detail', enrollment.id] });
      void queryClient.invalidateQueries({ queryKey: ['enrollment', 'history', enrollment.id] });
      void queryClient.invalidateQueries({ queryKey: ['enrollment', 'list'] });
      onOpenChange(false);
    },
    onError: (error: Error) => {
      toast.error('Could not change this status', { description: error.message });
    },
  });

  const canSubmit = Boolean(toStatus) && Boolean(effectiveOn) && reason.trim().length > 0 && !transitionMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (!transitionMutation.isPending ? onOpenChange(next) : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change enrollment status</DialogTitle>
          <DialogDescription>
            Currently <strong className="text-fg">{ENROLLMENT_STATUS_LABELS[enrollment.status]}</strong>. This is
            recorded permanently in the status history and cannot be edited afterwards.
          </DialogDescription>
        </DialogHeader>

        {legalNextStatuses.length === 0 ? (
          <p className="text-sm text-fg-muted">
            {ENROLLMENT_STATUS_LABELS[enrollment.status]} is a final status - there is no further transition
            available.
          </p>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor="transition-to-status">New status</Label>
              <Select value={toStatus} onValueChange={(value) => setToStatus(value as EnrollmentStatus)}>
                <SelectTrigger id="transition-to-status" aria-label="New status">
                  <SelectValue placeholder="Choose a status" />
                </SelectTrigger>
                <SelectContent>
                  {legalNextStatuses.map((status) => (
                    <SelectItem key={status} value={status}>
                      {ENROLLMENT_STATUS_LABELS[status]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="transition-effective-on">Effective date</Label>
              <Input
                id="transition-effective-on"
                type="date"
                value={effectiveOn}
                onChange={(event) => setEffectiveOn(event.target.value)}
              />
            </div>

            <div className="flex flex-col gap-2">
              <Label htmlFor="transition-reason">Reason</Label>
              <Textarea
                id="transition-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="e.g. Family relocated out of district."
                maxLength={500}
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={transitionMutation.isPending}>
            Cancel
          </Button>
          {legalNextStatuses.length > 0 ? (
            <Button onClick={() => transitionMutation.mutate()} disabled={!canSubmit} loading={transitionMutation.isPending}>
              Save status change
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
