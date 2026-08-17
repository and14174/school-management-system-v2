'use client';

import * as React from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Button,
  Checkbox,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  RadioGroup,
  RadioGroupItem,
  Textarea,
} from '@sms/ui';
import { mergePersons, type Person } from '../../../../lib/api';
import { fullName } from '../format';

export interface MergeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  current: Person;
  candidate: Person;
  onMerged: (survivingId: string) => void;
}

/**
 * Merging is destructive and one-way (see `PeopleContract.mergePersons`'s
 * own comment: it repoints every related row and tombstones the loser,
 * never deletes it, but there is no "unmerge"). Every path to submit here
 * names BOTH records explicitly - never a bare "Merge" button - and the
 * final confirm is disabled until a reason is entered and the destructive
 * checkbox is ticked.
 */
export function MergeDialog({ open, onOpenChange, current, candidate, onMerged }: MergeDialogProps) {
  const [survivorId, setSurvivorId] = React.useState(current.id);
  const [reason, setReason] = React.useState('');
  const [acknowledged, setAcknowledged] = React.useState(false);
  const queryClient = useQueryClient();

  React.useEffect(() => {
    if (open) {
      setSurvivorId(current.id);
      setReason('');
      setAcknowledged(false);
    }
  }, [open, current.id]);

  const survivor = survivorId === current.id ? current : candidate;
  const loser = survivorId === current.id ? candidate : current;

  const mergeMutation = useMutation({
    mutationFn: () => mergePersons({ survivingId: survivor.id, mergedId: loser.id, reason: reason.trim() }),
    onSuccess: () => {
      toast.success('Records merged', {
        description: `${fullName(loser)} was merged into ${fullName(survivor)}.`,
      });
      void queryClient.invalidateQueries({ queryKey: ['people'] });
      onOpenChange(false);
      onMerged(survivor.id);
    },
    onError: (error: Error) => {
      toast.error('Could not merge these records', { description: error.message });
    },
  });

  const canSubmit = reason.trim().length > 0 && acknowledged && !mergeMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={(next) => (!mergeMutation.isPending ? onOpenChange(next) : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Merge duplicate records</DialogTitle>
          <DialogDescription>
            This merges <strong className="text-fg">{fullName(loser)}</strong> into{' '}
            <strong className="text-fg">{fullName(survivor)}</strong>. Every role, relationship, identifier and
            alert on the merged record moves to the survivor, and the merged record is permanently retired. This
            cannot be undone.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label>Which record should survive?</Label>
            <RadioGroup value={survivorId} onValueChange={setSurvivorId}>
              <div className="flex items-center gap-2">
                <RadioGroupItem value={current.id} id="survivor-current" />
                <Label htmlFor="survivor-current" className="font-normal">
                  Keep {fullName(current)} (this profile)
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <RadioGroupItem value={candidate.id} id="survivor-candidate" />
                <Label htmlFor="survivor-candidate" className="font-normal">
                  Keep {fullName(candidate)} (the possible duplicate)
                </Label>
              </div>
            </RadioGroup>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="merge-reason">Reason for merging</Label>
            <Textarea
              id="merge-reason"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="e.g. Confirmed duplicate enrollment - same student, re-entered by front office."
              maxLength={500}
            />
          </div>

          <div className="flex items-start gap-2">
            <Checkbox
              id="merge-acknowledge"
              checked={acknowledged}
              onCheckedChange={(checked) => setAcknowledged(checked === true)}
            />
            <Label htmlFor="merge-acknowledge" className="font-normal text-fg-muted">
              I understand this merges {fullName(loser)} into {fullName(survivor)} and cannot be undone.
            </Label>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={mergeMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() => mergeMutation.mutate()}
            loading={mergeMutation.isPending}
            disabled={!canSubmit}
          >
            Merge records
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
