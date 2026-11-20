import {
  pgTable,
  uuid,
  varchar,
  text,
  integer,
  bigint,
  timestamp,
  uniqueIndex,
  primaryKey,
  jsonb,
  bigserial,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const users = pgTable(
  'users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    oidcIssuer: varchar('oidc_issuer', { length: 512 }).notNull(),
    oidcSub: varchar('oidc_sub', { length: 512 }).notNull(),
    email: varchar('email', { length: 255 }),
    displayName: varchar('display_name', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('users_oidc_issuer_sub_idx').on(t.oidcIssuer, t.oidcSub)],
);

export const groups = pgTable(
  'groups',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: varchar('name', { length: 255 }).notNull(),
    description: text('description'),
    retentionHours: integer('retention_hours').default(72).notNull(),
    status: varchar('status', { length: 32 }).default('active').notNull(),
    nextSequenceNumber: integer('next_sequence_number').default(1).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('groups_owner_name_idx').on(t.ownerId, t.name)],
);

export const images = pgTable(
  'images',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    groupId: uuid('group_id')
      .references(() => groups.id, { onDelete: 'cascade' })
      .notNull(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    sequenceNumber: integer('sequence_number').notNull(),
    originalFilename: varchar('original_filename', { length: 255 }).notNull(),
    mediaType: varchar('media_type', { length: 128 }).notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    width: integer('width'),
    height: integer('height'),
    description: text('description'),
    status: varchar('status', { length: 32 }).default('pending').notNull(), // 'pending', 'processing', 'ready', 'failed'
    deletionState: varchar('deletion_state', { length: 32 }).default('active').notNull(), // 'active', 'pending_deletion', 'deleted'
    deletionRequestedAt: timestamp('deletion_requested_at', { withTimezone: true }),
    deletionDeadline: timestamp('deletion_deadline', { withTimezone: true }),
    deletionRequestedBy: varchar('deletion_requested_by', { length: 255 }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('images_group_sequence_idx').on(t.groupId, t.sequenceNumber)],
);

export const imageVariants = pgTable(
  'image_variants',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    imageId: uuid('image_id')
      .references(() => images.id, { onDelete: 'cascade' })
      .notNull(),
    variantType: varchar('variant_type', { length: 32 }).notNull(), // 'original', 'thumbnail', 'preview'
    storageKey: varchar('storage_key', { length: 1024 }).notNull(),
    mediaType: varchar('media_type', { length: 128 }).notNull(),
    width: integer('width'),
    height: integer('height'),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('image_variants_image_type_idx').on(t.imageId, t.variantType)],
);

export const tags = pgTable(
  'tags',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    name: varchar('name', { length: 128 }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('tags_owner_name_idx').on(t.ownerId, t.name)],
);

export const imageTags = pgTable(
  'image_tags',
  {
    imageId: uuid('image_id')
      .references(() => images.id, { onDelete: 'cascade' })
      .notNull(),
    tagId: uuid('tag_id')
      .references(() => tags.id, { onDelete: 'cascade' })
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.imageId, t.tagId] })],
);

export const eventOutbox = pgTable(
  'event_outbox',
  {
    cursor: bigserial('cursor', { mode: 'number' }).primaryKey(),
    eventId: uuid('event_id').defaultRandom().notNull(),
    eventType: varchar('event_type', { length: 64 }).notNull(),
    ownerId: uuid('owner_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    groupId: uuid('group_id'),
    imageId: uuid('image_id'),
    payload: jsonb('payload').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('event_outbox_event_id_idx').on(t.eventId)],
);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id'),
  action: varchar('action', { length: 64 }).notNull(),
  targetType: varchar('target_type', { length: 32 }).notNull(),
  targetId: uuid('target_id').notNull(),
  details: jsonb('details'),
  actorType: varchar('actor_type', { length: 32 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});
