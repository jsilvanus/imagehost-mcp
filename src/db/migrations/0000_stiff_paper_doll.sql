CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"action" varchar(64) NOT NULL,
	"target_type" varchar(32) NOT NULL,
	"target_id" uuid NOT NULL,
	"details" jsonb,
	"actor_type" varchar(32) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "event_outbox" (
	"cursor" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"owner_id" uuid NOT NULL,
	"group_id" uuid,
	"image_id" uuid,
	"payload" jsonb NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"retention_hours" integer DEFAULT 72 NOT NULL,
	"status" varchar(32) DEFAULT 'active' NOT NULL,
	"next_sequence_number" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "image_tags" (
	"image_id" uuid NOT NULL,
	"tag_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_tags_image_id_tag_id_pk" PRIMARY KEY("image_id","tag_id")
);
--> statement-breakpoint
CREATE TABLE "image_variants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"image_id" uuid NOT NULL,
	"variant_type" varchar(32) NOT NULL,
	"storage_key" varchar(1024) NOT NULL,
	"media_type" varchar(128) NOT NULL,
	"width" integer,
	"height" integer,
	"byte_size" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "images" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"group_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"sequence_number" integer NOT NULL,
	"original_filename" varchar(255) NOT NULL,
	"media_type" varchar(128) NOT NULL,
	"byte_size" bigint NOT NULL,
	"width" integer,
	"height" integer,
	"description" text,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"deletion_state" varchar(32) DEFAULT 'active' NOT NULL,
	"deletion_requested_at" timestamp with time zone,
	"deletion_deadline" timestamp with time zone,
	"deletion_requested_by" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(128) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"oidc_issuer" varchar(512) NOT NULL,
	"oidc_sub" varchar(512) NOT NULL,
	"email" varchar(255),
	"display_name" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "event_outbox" ADD CONSTRAINT "event_outbox_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "groups" ADD CONSTRAINT "groups_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_tags" ADD CONSTRAINT "image_tags_tag_id_tags_id_fk" FOREIGN KEY ("tag_id") REFERENCES "public"."tags"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "image_variants" ADD CONSTRAINT "image_variants_image_id_images_id_fk" FOREIGN KEY ("image_id") REFERENCES "public"."images"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_group_id_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "images" ADD CONSTRAINT "images_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "event_outbox_event_id_idx" ON "event_outbox" USING btree ("event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "groups_owner_name_idx" ON "groups" USING btree ("owner_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "image_variants_image_type_idx" ON "image_variants" USING btree ("image_id","variant_type");--> statement-breakpoint
CREATE UNIQUE INDEX "images_group_sequence_idx" ON "images" USING btree ("group_id","sequence_number");--> statement-breakpoint
CREATE UNIQUE INDEX "tags_owner_name_idx" ON "tags" USING btree ("owner_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_issuer_sub_idx" ON "users" USING btree ("oidc_issuer","oidc_sub");