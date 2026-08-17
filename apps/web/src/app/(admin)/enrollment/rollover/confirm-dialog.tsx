'use client';

import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@sms/ui';

export interface ConfirmRolloverDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fromYearName: string;
  toYearName: string;
  promotedCount: number;
  consideredCount: number;
  onConfirm: () => void;
  isRunning: boolean;
}

/**
 * The largest destructive action in the product - run once a year, under
 * time pressure. The confirmation names both academic years explicitly and
 * the number of students it will actually change, never a bare "Are you
 * sure?".
 */
export function ConfirmRolloverDialog({
  open,
  onOpenChange,
  fromYearName,
  toYearName,
  promotedCount,
  consideredCount,
  onConfirm,
  isRunning,
}: ConfirmRolloverDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => (!isRunning ? onOpenChange(next) : undefined)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Run year rollover?</DialogTitle>
          <DialogDescription>
            This will promote <strong className="text-fg">{promotedCount}</strong> of{' '}
            <strong className="text-fg">{consideredCount}</strong> currently-enrolled students from{' '}
            <strong className="text-fg">{fromYearName}</strong> to <strong className="text-fg">{toYearName}</strong>,
            creating a new enrollment record for each and leaving their {fromYearName} record untouched. Students
            with no grade-level mapping, or already enrolled in {toYearName}, are skipped. This writes to the
            database - it is not a preview.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isRunning}>
            Cancel
          </Button>
          <Button variant="danger" onClick={onConfirm} loading={isRunning}>
            Run rollover
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
