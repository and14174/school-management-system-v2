import { Inject, Injectable } from '@nestjs/common';
import type { DomainError, NotFoundError, PersonId, Result } from '@sms/kernel';
import type {
  CalculateGpaInput,
  CheckPromotionEligibilityInput,
  CreateCreditRuleSetInput,
  CreditRuleSet,
  CreditRuleSetVersion,
  FinaliseTranscriptEntriesInput,
  IssueReportCardsInput,
  IssueReportCardsResult,
  ListReportCardsInput,
  PreviewReportCardInput,
  PromotionEligibility,
  PublishCreditRuleSetVersionInput,
  RecordsContract,
  ReportCard,
  ReportCardContext,
  ReportCardSnapshot,
  Transcript,
  TranscriptEntry,
} from '../contract.js';
import { currentTenantContext } from './current-context.js';
import { CreditRuleSetService } from './credit-rule-set.service.js';
import { ReportCardService } from './report-card.service.js';
import { TranscriptService } from './transcript.service.js';

/**
 * Implements `RecordsContract`. Thin composition layer over the individual
 * services - exactly the shape `GradebookService` composes
 * `GradeScaleService`/`ScoreService`/... in `@sms/gradebook`. Every method
 * resolves the ambient tenant via `currentTenantContext()`; the services
 * underneath all take `tenantId` explicitly so they also work from
 * `seed.ts` and from tests with no ambient context at all.
 */
@Injectable()
export class RecordsService implements RecordsContract {
  constructor(
    @Inject(ReportCardService) private readonly reportCards: ReportCardService,
    @Inject(TranscriptService) private readonly transcripts: TranscriptService,
    @Inject(CreditRuleSetService) private readonly creditRuleSets: CreditRuleSetService,
  ) {}

  previewReportCard(input: PreviewReportCardInput): Promise<Result<ReportCardSnapshot, DomainError>> {
    return this.reportCards.previewReportCard(currentTenantContext().tenantId, input);
  }
  issueReportCards(input: IssueReportCardsInput): Promise<Result<IssueReportCardsResult, DomainError>> {
    return this.reportCards.issueReportCards(currentTenantContext().tenantId, input);
  }
  getReportCard(id: string): Promise<Result<ReportCard, NotFoundError>> {
    return this.reportCards.getReportCard(currentTenantContext().tenantId, id);
  }
  listReportCards(input: ListReportCardsInput): Promise<ReportCard[]> {
    return this.reportCards.listReportCards(currentTenantContext().tenantId, input);
  }
  getReportCardContext(id: string): Promise<ReportCardContext | null> {
    return this.reportCards.getReportCardContext(currentTenantContext().tenantId, id);
  }

  finaliseTranscriptEntries(input: FinaliseTranscriptEntriesInput): Promise<Result<readonly TranscriptEntry[], DomainError>> {
    return this.transcripts.finaliseTranscriptEntries(currentTenantContext().tenantId, input);
  }
  getTranscript(personId: PersonId): Promise<Transcript> {
    return this.transcripts.getTranscript(currentTenantContext().tenantId, personId);
  }
  calculateGpa(input: CalculateGpaInput): Promise<number | null> {
    return this.transcripts.calculateGpa(currentTenantContext().tenantId, input);
  }
  checkPromotionEligibility(input: CheckPromotionEligibilityInput): Promise<Result<PromotionEligibility, DomainError>> {
    return this.transcripts.checkPromotionEligibility(currentTenantContext().tenantId, input);
  }

  createCreditRuleSet(input: CreateCreditRuleSetInput): Promise<Result<CreditRuleSet, DomainError>> {
    return this.creditRuleSets.createCreditRuleSet(currentTenantContext().tenantId, input);
  }
  listCreditRuleSets(): Promise<CreditRuleSet[]> {
    return this.creditRuleSets.listCreditRuleSets(currentTenantContext().tenantId);
  }
  publishCreditRuleSetVersion(input: PublishCreditRuleSetVersionInput): Promise<Result<CreditRuleSetVersion, DomainError>> {
    return this.creditRuleSets.publishCreditRuleSetVersion(currentTenantContext().tenantId, input);
  }
  listCreditRuleSetVersions(creditRuleSetId: string): Promise<CreditRuleSetVersion[]> {
    return this.creditRuleSets.listCreditRuleSetVersions(currentTenantContext().tenantId, creditRuleSetId);
  }
}
