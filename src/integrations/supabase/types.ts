export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      audit_log: {
        Row: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at: string
          diff: Json | null
          entity: string
          entity_id: string | null
          id: string
          user_id: string | null
        }
        Insert: {
          action: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          diff?: Json | null
          entity: string
          entity_id?: string | null
          id?: string
          user_id?: string | null
        }
        Update: {
          action?: Database["public"]["Enums"]["audit_action"]
          created_at?: string
          diff?: Json | null
          entity?: string
          entity_id?: string | null
          id?: string
          user_id?: string | null
        }
        Relationships: []
      }
      auth_throttle: {
        Row: {
          attempt_type: string
          attempted_at: string
          email_norm: string
          id: number
          success: boolean
        }
        Insert: {
          attempt_type: string
          attempted_at?: string
          email_norm: string
          id?: number
          success: boolean
        }
        Update: {
          attempt_type?: string
          attempted_at?: string
          email_norm?: string
          id?: number
          success?: boolean
        }
        Relationships: []
      }
      bed_occupancies: {
        Row: {
          actual_step_down: Database["public"]["Enums"]["bed_step_down"] | null
          admitted_at: string
          admitting_consultant: string | null
          bed_id: string
          created_at: string
          created_by: string | null
          discharged_at: string | null
          hfno: boolean
          hospital_number: string | null
          id: string
          isolation: Database["public"]["Enums"]["bed_isolation"]
          isolation_reason: string | null
          level: number
          nippv_cpap: boolean
          notes: string | null
          patient_initials: string | null
          predicted_discharge_at: string | null
          predicted_step_down:
            | Database["public"]["Enums"]["bed_step_down"]
            | null
          renal_replacement: boolean
          requires_side_room: boolean
          source_postop_booking_id: string | null
          source_referral_id: string | null
          tracheostomy: boolean
          updated_at: string
          updated_by: string | null
          vasopressors: boolean
          ventilated: boolean
        }
        Insert: {
          actual_step_down?: Database["public"]["Enums"]["bed_step_down"] | null
          admitted_at?: string
          admitting_consultant?: string | null
          bed_id: string
          created_at?: string
          created_by?: string | null
          discharged_at?: string | null
          hfno?: boolean
          hospital_number?: string | null
          id?: string
          isolation?: Database["public"]["Enums"]["bed_isolation"]
          isolation_reason?: string | null
          level?: number
          nippv_cpap?: boolean
          notes?: string | null
          patient_initials?: string | null
          predicted_discharge_at?: string | null
          predicted_step_down?:
            | Database["public"]["Enums"]["bed_step_down"]
            | null
          renal_replacement?: boolean
          requires_side_room?: boolean
          source_postop_booking_id?: string | null
          source_referral_id?: string | null
          tracheostomy?: boolean
          updated_at?: string
          updated_by?: string | null
          vasopressors?: boolean
          ventilated?: boolean
        }
        Update: {
          actual_step_down?: Database["public"]["Enums"]["bed_step_down"] | null
          admitted_at?: string
          admitting_consultant?: string | null
          bed_id?: string
          created_at?: string
          created_by?: string | null
          discharged_at?: string | null
          hfno?: boolean
          hospital_number?: string | null
          id?: string
          isolation?: Database["public"]["Enums"]["bed_isolation"]
          isolation_reason?: string | null
          level?: number
          nippv_cpap?: boolean
          notes?: string | null
          patient_initials?: string | null
          predicted_discharge_at?: string | null
          predicted_step_down?:
            | Database["public"]["Enums"]["bed_step_down"]
            | null
          renal_replacement?: boolean
          requires_side_room?: boolean
          source_postop_booking_id?: string | null
          source_referral_id?: string | null
          tracheostomy?: boolean
          updated_at?: string
          updated_by?: string | null
          vasopressors?: boolean
          ventilated?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "bed_occupancies_bed_id_fkey"
            columns: ["bed_id"]
            isOneToOne: false
            referencedRelation: "beds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bed_occupancies_source_postop_booking_id_fkey"
            columns: ["source_postop_booking_id"]
            isOneToOne: false
            referencedRelation: "postop_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "bed_occupancies_source_referral_id_fkey"
            columns: ["source_referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      bed_outliers: {
        Row: {
          admitting_consultant: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          ended_at: string | null
          hfno: boolean
          hospital_number: string | null
          id: string
          level: number
          nippv_cpap: boolean
          notes: string | null
          patient_initials: string | null
          reason: string | null
          renal_replacement: boolean
          started_at: string
          updated_at: string
          updated_by: string | null
          vasopressors: boolean
          ventilated: boolean
          ward: string
        }
        Insert: {
          admitting_consultant?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          ended_at?: string | null
          hfno?: boolean
          hospital_number?: string | null
          id?: string
          level?: number
          nippv_cpap?: boolean
          notes?: string | null
          patient_initials?: string | null
          reason?: string | null
          renal_replacement?: boolean
          started_at?: string
          updated_at?: string
          updated_by?: string | null
          vasopressors?: boolean
          ventilated?: boolean
          ward: string
        }
        Update: {
          admitting_consultant?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          ended_at?: string | null
          hfno?: boolean
          hospital_number?: string | null
          id?: string
          level?: number
          nippv_cpap?: boolean
          notes?: string | null
          patient_initials?: string | null
          reason?: string | null
          renal_replacement?: boolean
          started_at?: string
          updated_at?: string
          updated_by?: string | null
          vasopressors?: boolean
          ventilated?: boolean
          ward?: string
        }
        Relationships: []
      }
      bed_transfers_out: {
        Row: {
          accepted_at: string | null
          cancel_reason: string | null
          cancelled_at: string | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          deleted_at: string | null
          deleted_by: string | null
          departed_at: string | null
          destination_hospital: string
          destination_specialty: string | null
          eta_at: string | null
          id: string
          kind: Database["public"]["Enums"]["bed_transfer_kind"]
          notes: string | null
          occupancy_id: string | null
          reason: string | null
          requested_at: string
          status: Database["public"]["Enums"]["bed_transfer_status"]
          transport_mode:
            | Database["public"]["Enums"]["bed_transport_mode"]
            | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          accepted_at?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          departed_at?: string | null
          destination_hospital: string
          destination_specialty?: string | null
          eta_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["bed_transfer_kind"]
          notes?: string | null
          occupancy_id?: string | null
          reason?: string | null
          requested_at?: string
          status?: Database["public"]["Enums"]["bed_transfer_status"]
          transport_mode?:
            | Database["public"]["Enums"]["bed_transport_mode"]
            | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          accepted_at?: string | null
          cancel_reason?: string | null
          cancelled_at?: string | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          departed_at?: string | null
          destination_hospital?: string
          destination_specialty?: string | null
          eta_at?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["bed_transfer_kind"]
          notes?: string | null
          occupancy_id?: string | null
          reason?: string | null
          requested_at?: string
          status?: Database["public"]["Enums"]["bed_transfer_status"]
          transport_mode?:
            | Database["public"]["Enums"]["bed_transport_mode"]
            | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "bed_transfers_out_occupancy_id_fkey"
            columns: ["occupancy_id"]
            isOneToOne: false
            referencedRelation: "bed_occupancies"
            referencedColumns: ["id"]
          },
        ]
      }
      beds: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          is_side_room: boolean
          notes: string | null
          sort_order: number
          unit: Database["public"]["Enums"]["bed_unit"]
          updated_at: string
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          is_side_room?: boolean
          notes?: string | null
          sort_order?: number
          unit: Database["public"]["Enums"]["bed_unit"]
          updated_at?: string
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          is_side_room?: boolean
          notes?: string | null
          sort_order?: number
          unit?: Database["public"]["Enums"]["bed_unit"]
          updated_at?: string
        }
        Relationships: []
      }
      icnarc_targets: {
        Row: {
          decision_to_arrival_target_min: number
          id: boolean
          time_to_seen_target_min: number
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          decision_to_arrival_target_min?: number
          id?: boolean
          time_to_seen_target_min?: number
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          decision_to_arrival_target_min?: number
          id?: boolean
          time_to_seen_target_min?: number
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      notification_deliveries: {
        Row: {
          actor_id: string | null
          channel: string
          delivered_at: string | null
          endpoint: string | null
          error: string | null
          generated_at: string
          id: string
          kind: string
          notification_id: string | null
          recipient_id: string
          referral_id: string | null
          status: string
        }
        Insert: {
          actor_id?: string | null
          channel: string
          delivered_at?: string | null
          endpoint?: string | null
          error?: string | null
          generated_at?: string
          id?: string
          kind: string
          notification_id?: string | null
          recipient_id: string
          referral_id?: string | null
          status: string
        }
        Update: {
          actor_id?: string | null
          channel?: string
          delivered_at?: string | null
          endpoint?: string | null
          error?: string | null
          generated_at?: string
          id?: string
          kind?: string
          notification_id?: string | null
          recipient_id?: string
          referral_id?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "notification_deliveries_notification_id_fkey"
            columns: ["notification_id"]
            isOneToOne: false
            referencedRelation: "notifications"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          created_at: string
          id: string
          kind: string
          message: string
          read_at: string | null
          referral_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind: string
          message: string
          read_at?: string | null
          referral_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: string
          message?: string
          read_at?: string | null
          referral_id?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "notifications_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      postop_bookings: {
        Row: {
          age: number | null
          arrived_at: string | null
          bmi: number | null
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          height_cm: number | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          is_test: boolean
          past_medical_history_enc: string | null
          past_surgical_history_enc: string | null
          predicted_level: Database["public"]["Enums"]["postop_level"]
          proposed_procedure_enc: string | null
          proposed_surgery_date: string | null
          reason_for_bed_enc: string | null
          sex: string | null
          social_history_enc: string | null
          surgical_specialty: string | null
          updated_at: string
          updated_by: string | null
          weight_kg: number | null
        }
        Insert: {
          age?: number | null
          arrived_at?: string | null
          bmi?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          height_cm?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          is_test?: boolean
          past_medical_history_enc?: string | null
          past_surgical_history_enc?: string | null
          predicted_level: Database["public"]["Enums"]["postop_level"]
          proposed_procedure_enc?: string | null
          proposed_surgery_date?: string | null
          reason_for_bed_enc?: string | null
          sex?: string | null
          social_history_enc?: string | null
          surgical_specialty?: string | null
          updated_at?: string
          updated_by?: string | null
          weight_kg?: number | null
        }
        Update: {
          age?: number | null
          arrived_at?: string | null
          bmi?: number | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          height_cm?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          is_test?: boolean
          past_medical_history_enc?: string | null
          past_surgical_history_enc?: string | null
          predicted_level?: Database["public"]["Enums"]["postop_level"]
          proposed_procedure_enc?: string | null
          proposed_surgery_date?: string | null
          reason_for_bed_enc?: string | null
          sex?: string | null
          social_history_enc?: string | null
          surgical_specialty?: string | null
          updated_at?: string
          updated_by?: string | null
          weight_kg?: number | null
        }
        Relationships: []
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          is_at_work: boolean
          job_title: string | null
          notify_new_referral: boolean
          notify_notes: boolean
          notify_status: boolean
          notify_updated_referral: boolean
          shift_updated_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          is_at_work?: boolean
          job_title?: string | null
          notify_new_referral?: boolean
          notify_notes?: boolean
          notify_status?: boolean
          notify_updated_referral?: boolean
          shift_updated_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          is_at_work?: boolean
          job_title?: string | null
          notify_new_referral?: boolean
          notify_notes?: boolean
          notify_status?: boolean
          notify_updated_referral?: boolean
          shift_updated_at?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          endpoint: string
          id: string
          last_used_at: string | null
          p256dh: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          endpoint: string
          id?: string
          last_used_at?: string | null
          p256dh: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          endpoint?: string
          id?: string
          last_used_at?: string | null
          p256dh?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: []
      }
      referral_note_keys: {
        Row: {
          created_at: string
          note_id: string
          recipient_user_id: string
          wrapped_key: string
        }
        Insert: {
          created_at?: string
          note_id: string
          recipient_user_id: string
          wrapped_key: string
        }
        Update: {
          created_at?: string
          note_id?: string
          recipient_user_id?: string
          wrapped_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_note_keys_note_id_fkey"
            columns: ["note_id"]
            isOneToOne: false
            referencedRelation: "referral_notes"
            referencedColumns: ["id"]
          },
        ]
      }
      referral_notes: {
        Row: {
          author_id: string
          body_ciphertext: string | null
          body_enc: string | null
          body_nonce: string | null
          created_at: string
          edited_at: string | null
          enc_version: number | null
          id: string
          referral_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          body_ciphertext?: string | null
          body_enc?: string | null
          body_nonce?: string | null
          created_at?: string
          edited_at?: string | null
          enc_version?: number | null
          id?: string
          referral_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body_ciphertext?: string | null
          body_enc?: string | null
          body_nonce?: string | null
          created_at?: string
          edited_at?: string | null
          enc_version?: number | null
          id?: string
          referral_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_notes_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      referrals: {
        Row: {
          accepting_consultant: string | null
          admission_urgency:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age: number | null
          arrived_on_unit_at: string | null
          baseline_function_enc: string | null
          consultant_to_consultant_only: boolean
          created_at: string
          created_by: string | null
          current_bed: string | null
          current_ward: string | null
          decision_at: string | null
          decline_reason: string | null
          deleted_at: string | null
          deleted_by: string | null
          discussed_with_consultant: string | null
          dnacpr_respect: boolean
          first_seen_at: string | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          is_test: boolean
          past_medical_history_enc: string | null
          reason_for_referral_enc: string | null
          referral_received_at: string
          referring_specialty: string | null
          sex: Database["public"]["Enums"]["patient_sex"] | null
          status: Database["public"]["Enums"]["referral_status"]
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          accepting_consultant?: string | null
          admission_urgency?:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age?: number | null
          arrived_on_unit_at?: string | null
          baseline_function_enc?: string | null
          consultant_to_consultant_only?: boolean
          created_at?: string
          created_by?: string | null
          current_bed?: string | null
          current_ward?: string | null
          decision_at?: string | null
          decline_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          discussed_with_consultant?: string | null
          dnacpr_respect?: boolean
          first_seen_at?: string | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          is_test?: boolean
          past_medical_history_enc?: string | null
          reason_for_referral_enc?: string | null
          referral_received_at?: string
          referring_specialty?: string | null
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          accepting_consultant?: string | null
          admission_urgency?:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age?: number | null
          arrived_on_unit_at?: string | null
          baseline_function_enc?: string | null
          consultant_to_consultant_only?: boolean
          created_at?: string
          created_by?: string | null
          current_bed?: string | null
          current_ward?: string | null
          decision_at?: string | null
          decline_reason?: string | null
          deleted_at?: string | null
          deleted_by?: string | null
          discussed_with_consultant?: string | null
          dnacpr_respect?: boolean
          first_seen_at?: string | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          is_test?: boolean
          past_medical_history_enc?: string | null
          reason_for_referral_enc?: string | null
          referral_received_at?: string
          referring_specialty?: string | null
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      user_private_key_material: {
        Row: {
          created_at: string
          encrypted_private_key: string
          kdf_mem: number
          kdf_ops: number
          kdf_salt: string
          nonce: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          encrypted_private_key: string
          kdf_mem: number
          kdf_ops: number
          kdf_salt: string
          nonce: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          encrypted_private_key?: string
          kdf_mem?: number
          kdf_ops?: number
          kdf_salt?: string
          nonce?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_public_keys: {
        Row: {
          created_at: string
          public_key: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          public_key: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          public_key?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      webauthn_challenges: {
        Row: {
          challenge: string
          created_at: string
          email_norm: string | null
          expires_at: string
          id: string
          kind: string
          user_id: string | null
        }
        Insert: {
          challenge: string
          created_at?: string
          email_norm?: string | null
          expires_at?: string
          id?: string
          kind: string
          user_id?: string | null
        }
        Update: {
          challenge?: string
          created_at?: string
          email_norm?: string | null
          expires_at?: string
          id?: string
          kind?: string
          user_id?: string | null
        }
        Relationships: []
      }
      webauthn_credentials: {
        Row: {
          aaguid: string | null
          counter: number
          created_at: string
          credential_id: string
          device_label: string | null
          id: string
          last_used_at: string | null
          public_key: string
          transports: string[]
          user_id: string
        }
        Insert: {
          aaguid?: string | null
          counter?: number
          created_at?: string
          credential_id: string
          device_label?: string | null
          id?: string
          last_used_at?: string | null
          public_key: string
          transports?: string[]
          user_id: string
        }
        Update: {
          aaguid?: string | null
          counter?: number
          created_at?: string
          credential_id?: string
          device_label?: string | null
          id?: string
          last_used_at?: string | null
          public_key?: string
          transports?: string[]
          user_id?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      begin_auth_attempt: {
        Args: { _attempt_type: string; _email: string }
        Returns: Json
      }
      claim_push_subscription: {
        Args: {
          p_auth: string
          p_endpoint: string
          p_p256dh: string
          p_user_agent?: string
        }
        Returns: undefined
      }
      finalize_auth_attempt: {
        Args: { _attempt_id: number; _success: boolean }
        Returns: undefined
      }
      has_clinical_access: { Args: { _user_id: string }; Returns: boolean }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      lookup_user_id_by_email: { Args: { _email: string }; Returns: string }
    }
    Enums: {
      admission_urgency:
        | "within_15_min"
        | "within_30_min"
        | "within_1_hour"
        | "within_1_2_hours"
        | "not_admitting"
      app_role: "admin" | "clinician"
      audit_action:
        | "view"
        | "create"
        | "update"
        | "delete"
        | "issue"
        | "enable"
        | "unlock"
        | "reissue"
      bed_isolation: "none" | "contact" | "droplet" | "airborne"
      bed_step_down: "ward" | "hdu" | "home" | "other"
      bed_transfer_kind: "repat" | "tertiary" | "other"
      bed_transfer_status:
        | "requested"
        | "accepted"
        | "awaiting_transport"
        | "in_transit"
        | "completed"
        | "cancelled"
      bed_transport_mode: "land_ambulance" | "air" | "self" | "other"
      bed_unit: "icu" | "hdu"
      patient_sex: "male" | "female" | "other" | "unknown"
      postop_level: "level_1" | "level_2" | "level_3"
      referral_status: "pending" | "declined" | "admitted" | "accepted"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      admission_urgency: [
        "within_15_min",
        "within_30_min",
        "within_1_hour",
        "within_1_2_hours",
        "not_admitting",
      ],
      app_role: ["admin", "clinician"],
      audit_action: [
        "view",
        "create",
        "update",
        "delete",
        "issue",
        "enable",
        "unlock",
        "reissue",
      ],
      bed_isolation: ["none", "contact", "droplet", "airborne"],
      bed_step_down: ["ward", "hdu", "home", "other"],
      bed_transfer_kind: ["repat", "tertiary", "other"],
      bed_transfer_status: [
        "requested",
        "accepted",
        "awaiting_transport",
        "in_transit",
        "completed",
        "cancelled",
      ],
      bed_transport_mode: ["land_ambulance", "air", "self", "other"],
      bed_unit: ["icu", "hdu"],
      patient_sex: ["male", "female", "other", "unknown"],
      postop_level: ["level_1", "level_2", "level_3"],
      referral_status: ["pending", "declined", "admitted", "accepted"],
    },
  },
} as const
