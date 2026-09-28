import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/tenantContext.js';
import { reserveAttachmentSchema } from '../validators/attachment.js';
import {
  reserveAttachment,
  commitAttachment,
  listAttachments,
  getAttachment,
  deleteAttachment,
} from '../services/attachmentService.js';
import { logger } from '../lib/logger.js';

export const attachmentsRouter = Router({ mergeParams: true });
attachmentsRouter.use(requireAuth);

type IssueParams = { projectId: string; issueId: string };

attachmentsRouter.post('/reserve', async (req: Request<IssueParams>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const issueId = z.string().uuid().parse(req.params.issueId);
    const input = reserveAttachmentSchema.parse(req.body);
    const { attachment, uploadUrl } = await reserveAttachment(projectId, issueId, input);
    logger.info({ attachmentId: attachment.id, issueId }, 'attachment reserved');
    res.status(201).json({ attachment, uploadUrl });
  } catch (error) {
    next(error);
  }
});

attachmentsRouter.post('/:id/commit', async (req: Request<IssueParams & { id: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const issueId = z.string().uuid().parse(req.params.issueId);
    const id = z.string().uuid().parse(req.params.id);
    const attachment = await commitAttachment(projectId, issueId, id);
    logger.info({ attachmentId: id, issueId }, 'attachment committed');
    res.json(attachment);
  } catch (error) {
    next(error);
  }
});

attachmentsRouter.get('/', async (req: Request<IssueParams>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const issueId = z.string().uuid().parse(req.params.issueId);
    res.json(await listAttachments(projectId, issueId));
  } catch (error) {
    next(error);
  }
});

attachmentsRouter.get('/:id', async (req: Request<IssueParams & { id: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const issueId = z.string().uuid().parse(req.params.issueId);
    const id = z.string().uuid().parse(req.params.id);
    res.json(await getAttachment(projectId, issueId, id));
  } catch (error) {
    next(error);
  }
});

attachmentsRouter.delete('/:id', async (req: Request<IssueParams & { id: string }>, res, next) => {
  try {
    const projectId = z.string().uuid().parse(req.params.projectId);
    const issueId = z.string().uuid().parse(req.params.issueId);
    const id = z.string().uuid().parse(req.params.id);
    await deleteAttachment(projectId, issueId, id);
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
