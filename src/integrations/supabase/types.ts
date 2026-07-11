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
          patient_id: string | null
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
          wardable: boolean
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
          patient_id?: string | null
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
          wardable?: boolean
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
          patient_id?: string | null
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
          wardable?: boolean
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
            foreignKeyName: "bed_occupancies_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
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
      bridge_reconcile_job_items: {
        Row: {
          error: string | null
          finished_at: string | null
          id: string
          job_id: string
          locked_since: string | null
          pulled: number
          pulled_ids: Json
          pushed: number
          pushed_ids: Json
          resource: string
          skipped: number
          started_at: string | null
          status: Database["public"]["Enums"]["bridge_reconcile_item_status"]
          updated_at: string
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: string
          job_id: string
          locked_since?: string | null
          pulled?: number
          pulled_ids?: Json
          pushed?: number
          pushed_ids?: Json
          resource: string
          skipped?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["bridge_reconcile_item_status"]
          updated_at?: string
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: string
          job_id?: string
          locked_since?: string | null
          pulled?: number
          pulled_ids?: Json
          pushed?: number
          pushed_ids?: Json
          resource?: string
          skipped?: number
          started_at?: string | null
          status?: Database["public"]["Enums"]["bridge_reconcile_item_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bridge_reconcile_job_items_job_id_fkey"
            columns: ["job_id"]
            isOneToOne: false
            referencedRelation: "bridge_reconcile_jobs"
            referencedColumns: ["id"]
          },
        ]
      }
      bridge_reconcile_jobs: {
        Row: {
          created_at: string
          dry_run: boolean
          error: string | null
          finished_at: string | null
          from_ts: string
          id: string
          requested_by: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["bridge_reconcile_job_status"]
          to_ts: string
        }
        Insert: {
          created_at?: string
          dry_run?: boolean
          error?: string | null
          finished_at?: string | null
          from_ts: string
          id?: string
          requested_by?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["bridge_reconcile_job_status"]
          to_ts: string
        }
        Update: {
          created_at?: string
          dry_run?: boolean
          error?: string | null
          finished_at?: string | null
          from_ts?: string
          id?: string
          requested_by?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["bridge_reconcile_job_status"]
          to_ts?: string
        }
        Relationships: []
      }
      bridge_reconcile_locks: {
        Row: {
          from_ts: string
          id: string
          locked_at: string
          locked_by: string | null
          resource: string
          to_ts: string
        }
        Insert: {
          from_ts: string
          id?: string
          locked_at?: string
          locked_by?: string | null
          resource: string
          to_ts: string
        }
        Update: {
          from_ts?: string
          id?: string
          locked_at?: string
          locked_by?: string | null
          resource?: string
          to_ts?: string
        }
        Relationships: []
      }
      bridge_sync_attempts: {
        Row: {
          attempted_at: string
          duration_ms: number | null
          error: string | null
          id: number
          ok: boolean
          pulled: number
          pushed: number
          resource: string
          source: string
        }
        Insert: {
          attempted_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: number
          ok: boolean
          pulled?: number
          pushed?: number
          resource: string
          source: string
        }
        Update: {
          attempted_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: number
          ok?: boolean
          pulled?: number
          pushed?: number
          resource?: string
          source?: string
        }
        Relationships: []
      }
      bridge_sync_state: {
        Row: {
          last_error: string | null
          last_error_at: string | null
          last_pulled_at: string | null
          last_pushed_at: string | null
          resource: string
          updated_at: string
        }
        Insert: {
          last_error?: string | null
          last_error_at?: string | null
          last_pulled_at?: string | null
          last_pushed_at?: string | null
          resource: string
          updated_at?: string
        }
        Update: {
          last_error?: string | null
          last_error_at?: string | null
          last_pulled_at?: string | null
          last_pushed_at?: string | null
          resource?: string
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
      investigations: {
        Row: {
          category: string
          created_at: string
          created_by: string | null
          findings: string
          id: string
          patient_id: string
          result_at: string
          updated_at: string
        }
        Insert: {
          category: string
          created_at?: string
          created_by?: string | null
          findings: string
          id?: string
          patient_id: string
          result_at?: string
          updated_at?: string
        }
        Update: {
          category?: string
          created_at?: string
          created_by?: string | null
          findings?: string
          id?: string
          patient_id?: string
          result_at?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "investigations_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
      }
      message_templates: {
        Row: {
          active: boolean
          body: string
          category: string
          created_at: string
          created_by: string | null
          id: string
          title: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          body: string
          category: string
          created_at?: string
          created_by?: string | null
          id?: string
          title: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          body?: string
          category?: string
          created_at?: string
          created_by?: string | null
          id?: string
          title?: string
          updated_at?: string
        }
        Relationships: []
      }
      microbiology: {
        Row: {
          created_at: string
          created_by: string | null
          id: string
          notes: string | null
          organism: string
          patient_id: string
          reported_at: string
          sample_type: string | null
          sampled_at: string | null
          sensitivities: Json
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          organism: string
          patient_id: string
          reported_at?: string
          sample_type?: string | null
          sampled_at?: string | null
          sensitivities?: Json
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          notes?: string | null
          organism?: string
          patient_id?: string
          reported_at?: string
          sample_type?: string | null
          sampled_at?: string | null
          sensitivities?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "microbiology_patient_id_fkey"
            columns: ["patient_id"]
            isOneToOne: false
            referencedRelation: "patients"
            referencedColumns: ["id"]
          },
        ]
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
          expired_at: string | null
          id: string
          kind: string
          message: string
          read_at: string | null
          referral_id: string | null
          user_id: string
        }
        Insert: {
          created_at?: string
          expired_at?: string | null
          id?: string
          kind: string
          message: string
          read_at?: string | null
          referral_id?: string | null
          user_id: string
        }
        Update: {
          created_at?: string
          expired_at?: string | null
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
      nurse_capacity_alert_state: {
        Row: {
          id: boolean
          level1_available: boolean | null
          level1_last_alerted_at: string | null
          level1_slots: number | null
          level2_available: boolean | null
          level2_last_alerted_at: string | null
          level2_slots: number | null
          level3_available: boolean | null
          level3_last_alerted_at: string | null
          level3_slots: number | null
          shift_key: string | null
          spare: number | null
          updated_at: string
        }
        Insert: {
          id?: boolean
          level1_available?: boolean | null
          level1_last_alerted_at?: string | null
          level1_slots?: number | null
          level2_available?: boolean | null
          level2_last_alerted_at?: string | null
          level2_slots?: number | null
          level3_available?: boolean | null
          level3_last_alerted_at?: string | null
          level3_slots?: number | null
          shift_key?: string | null
          spare?: number | null
          updated_at?: string
        }
        Update: {
          id?: boolean
          level1_available?: boolean | null
          level1_last_alerted_at?: string | null
          level1_slots?: number | null
          level2_available?: boolean | null
          level2_last_alerted_at?: string | null
          level2_slots?: number | null
          level3_available?: boolean | null
          level3_last_alerted_at?: string | null
          level3_slots?: number | null
          shift_key?: string | null
          spare?: number | null
          updated_at?: string
        }
        Relationships: []
      }
      nurse_staffing: {
        Row: {
          available_nurses: number
          created_at: string
          id: string
          notes: string | null
          recorded_by: string | null
          shift: string
          shift_date: string
          updated_at: string
        }
        Insert: {
          available_nurses: number
          created_at?: string
          id?: string
          notes?: string | null
          recorded_by?: string | null
          shift: string
          shift_date: string
          updated_at?: string
        }
        Update: {
          available_nurses?: number
          created_at?: string
          id?: string
          notes?: string | null
          recorded_by?: string | null
          shift?: string
          shift_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      patient_acuity_history: {
        Row: {
          id: string
          level: number | null
          partner_patient_id: string
          recorded_at: string
          recorded_by: string | null
          source: string
        }
        Insert: {
          id?: string
          level?: number | null
          partner_patient_id: string
          recorded_at?: string
          recorded_by?: string | null
          source: string
        }
        Update: {
          id?: string
          level?: number | null
          partner_patient_id?: string
          recorded_at?: string
          recorded_by?: string | null
          source?: string
        }
        Relationships: []
      }
      patient_acuity_overrides: {
        Row: {
          level: number
          partner_patient_id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          level: number
          partner_patient_id: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          level?: number
          partner_patient_id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      patients: {
        Row: {
          admission_date: string | null
          bed: string | null
          created_at: string
          created_by: string | null
          current_admission: string | null
          current_management: string | null
          date_of_death: string | null
          discharge_date: string | null
          discharge_destination: string | null
          dnacpr_date: string | null
          dnacpr_decision: boolean
          dnacpr_details: string | null
          dob: string | null
          full_name: string
          hospital_number: string | null
          id: string
          location_type: Database["public"]["Enums"]["patient_location"]
          nhs_number: string | null
          nok_contact: string | null
          nok_last_updated: string | null
          nok_last_updated_by: string | null
          nok_name: string | null
          nok_relationship: string | null
          outstanding_tasks: string | null
          past_medical_history: string | null
          status: Database["public"]["Enums"]["patient_status"]
          tep_details: string | null
          tep_in_place: boolean
          updated_at: string
          updated_by: string | null
          ward: string | null
        }
        Insert: {
          admission_date?: string | null
          bed?: string | null
          created_at?: string
          created_by?: string | null
          current_admission?: string | null
          current_management?: string | null
          date_of_death?: string | null
          discharge_date?: string | null
          discharge_destination?: string | null
          dnacpr_date?: string | null
          dnacpr_decision?: boolean
          dnacpr_details?: string | null
          dob?: string | null
          full_name: string
          hospital_number?: string | null
          id?: string
          location_type?: Database["public"]["Enums"]["patient_location"]
          nhs_number?: string | null
          nok_contact?: string | null
          nok_last_updated?: string | null
          nok_last_updated_by?: string | null
          nok_name?: string | null
          nok_relationship?: string | null
          outstanding_tasks?: string | null
          past_medical_history?: string | null
          status?: Database["public"]["Enums"]["patient_status"]
          tep_details?: string | null
          tep_in_place?: boolean
          updated_at?: string
          updated_by?: string | null
          ward?: string | null
        }
        Update: {
          admission_date?: string | null
          bed?: string | null
          created_at?: string
          created_by?: string | null
          current_admission?: string | null
          current_management?: string | null
          date_of_death?: string | null
          discharge_date?: string | null
          discharge_destination?: string | null
          dnacpr_date?: string | null
          dnacpr_decision?: boolean
          dnacpr_details?: string | null
          dob?: string | null
          full_name?: string
          hospital_number?: string | null
          id?: string
          location_type?: Database["public"]["Enums"]["patient_location"]
          nhs_number?: string | null
          nok_contact?: string | null
          nok_last_updated?: string | null
          nok_last_updated_by?: string | null
          nok_name?: string | null
          nok_relationship?: string | null
          outstanding_tasks?: string | null
          past_medical_history?: string | null
          status?: Database["public"]["Enums"]["patient_status"]
          tep_details?: string | null
          tep_in_place?: boolean
          updated_at?: string
          updated_by?: string | null
          ward?: string | null
        }
        Relationships: []
      }
      postop_bookings: {
        Row: {
          age: number | null
          arrived_at: string | null
          bmi: number | null
          booking_status: Database["public"]["Enums"]["postop_booking_status"]
          cancellation_notes: string | null
          cancellation_reason:
            | Database["public"]["Enums"]["postop_cancellation_reason"]
            | null
          cancelled_at: string | null
          cancelled_by: string | null
          converted_referral_id: string | null
          created_at: string
          created_by: string
          deleted_at: string | null
          deleted_by: string | null
          height_cm: number | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          intensivist_reviewed_at: string | null
          intensivist_reviewed_by: string | null
          is_test: boolean
          past_medical_history_enc: string | null
          past_surgical_history_enc: string | null
          patient_initials: string | null
          predicted_level: Database["public"]["Enums"]["postop_level"]
          preop_signed_off_at: string | null
          preop_signed_off_by: string | null
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
          booking_status?: Database["public"]["Enums"]["postop_booking_status"]
          cancellation_notes?: string | null
          cancellation_reason?:
            | Database["public"]["Enums"]["postop_cancellation_reason"]
            | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          converted_referral_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          height_cm?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          intensivist_reviewed_at?: string | null
          intensivist_reviewed_by?: string | null
          is_test?: boolean
          past_medical_history_enc?: string | null
          past_surgical_history_enc?: string | null
          patient_initials?: string | null
          predicted_level: Database["public"]["Enums"]["postop_level"]
          preop_signed_off_at?: string | null
          preop_signed_off_by?: string | null
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
          booking_status?: Database["public"]["Enums"]["postop_booking_status"]
          cancellation_notes?: string | null
          cancellation_reason?:
            | Database["public"]["Enums"]["postop_cancellation_reason"]
            | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          converted_referral_id?: string | null
          created_at?: string
          created_by?: string
          deleted_at?: string | null
          deleted_by?: string | null
          height_cm?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          intensivist_reviewed_at?: string | null
          intensivist_reviewed_by?: string | null
          is_test?: boolean
          past_medical_history_enc?: string | null
          past_surgical_history_enc?: string | null
          patient_initials?: string | null
          predicted_level?: Database["public"]["Enums"]["postop_level"]
          preop_signed_off_at?: string | null
          preop_signed_off_by?: string | null
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
        Relationships: [
          {
            foreignKeyName: "postop_bookings_converted_referral_id_fkey"
            columns: ["converted_referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          is_at_work: boolean
          job_title: string | null
          notify_capacity: boolean
          notify_capacity_l1: boolean
          notify_capacity_l2: boolean
          notify_capacity_l3: boolean
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
          notify_capacity?: boolean
          notify_capacity_l1?: boolean
          notify_capacity_l2?: boolean
          notify_capacity_l3?: boolean
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
          notify_capacity?: boolean
          notify_capacity_l1?: boolean
          notify_capacity_l2?: boolean
          notify_capacity_l3?: boolean
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
      referral_messages: {
        Row: {
          body: string
          channel: string
          created_at: string
          direction: string
          id: string
          recipient: string | null
          referral_id: string
          sent_at: string
          sent_by: string
          template_id: string | null
        }
        Insert: {
          body: string
          channel: string
          created_at?: string
          direction?: string
          id?: string
          recipient?: string | null
          referral_id: string
          sent_at?: string
          sent_by?: string
          template_id?: string | null
        }
        Update: {
          body?: string
          channel?: string
          created_at?: string
          direction?: string
          id?: string
          recipient?: string | null
          referral_id?: string
          sent_at?: string
          sent_by?: string
          template_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "referral_messages_referral_id_fkey"
            columns: ["referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referral_messages_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "message_templates"
            referencedColumns: ["id"]
          },
        ]
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
      referral_tasks: {
        Row: {
          assigned_role: Database["public"]["Enums"]["app_role"] | null
          completed_at: string | null
          completed_by: string | null
          created_at: string
          created_by: string
          details: string | null
          due_at: string | null
          id: string
          referral_id: string
          status: string
          title: string
          updated_at: string
        }
        Insert: {
          assigned_role?: Database["public"]["Enums"]["app_role"] | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          details?: string | null
          due_at?: string | null
          id?: string
          referral_id: string
          status?: string
          title: string
          updated_at?: string
        }
        Update: {
          assigned_role?: Database["public"]["Enums"]["app_role"] | null
          completed_at?: string | null
          completed_by?: string | null
          created_at?: string
          created_by?: string
          details?: string | null
          due_at?: string | null
          id?: string
          referral_id?: string
          status?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "referral_tasks_referral_id_fkey"
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
          allergies: string | null
          anticipated_interventions: string[]
          arrived_on_unit_at: string | null
          baseline_function_enc: string | null
          ceiling_of_care: Database["public"]["Enums"]["ceiling_of_care"] | null
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
          for_ongoing_ccot_review: boolean
          frailty_score: number | null
          hospital_number_enc: string | null
          hospital_number_hash: string | null
          id: string
          infection_organism: string | null
          infection_status:
            | Database["public"]["Enums"]["infection_status"]
            | null
          is_test: boolean
          needs_ward_review: boolean
          news2_recorded_at: string | null
          news2_score: number | null
          origin_booking_id: string | null
          outcome: Database["public"]["Enums"]["referral_outcome"] | null
          outcome_recorded_at: string | null
          past_medical_history_enc: string | null
          patient_initials: string | null
          previous_referral_id: string | null
          reason_category:
            | Database["public"]["Enums"]["referral_reason_category"]
            | null
          reason_for_referral_enc: string | null
          referral_received_at: string
          referring_specialty: string | null
          resus_status: Database["public"]["Enums"]["resus_status"] | null
          sex: Database["public"]["Enums"]["patient_sex"] | null
          status: Database["public"]["Enums"]["referral_status"]
          updated_at: string
          updated_by: string | null
          ward_review_timeframe: string | null
          weight_kg: number | null
        }
        Insert: {
          accepting_consultant?: string | null
          admission_urgency?:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age?: number | null
          allergies?: string | null
          anticipated_interventions?: string[]
          arrived_on_unit_at?: string | null
          baseline_function_enc?: string | null
          ceiling_of_care?:
            | Database["public"]["Enums"]["ceiling_of_care"]
            | null
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
          for_ongoing_ccot_review?: boolean
          frailty_score?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          infection_organism?: string | null
          infection_status?:
            | Database["public"]["Enums"]["infection_status"]
            | null
          is_test?: boolean
          needs_ward_review?: boolean
          news2_recorded_at?: string | null
          news2_score?: number | null
          origin_booking_id?: string | null
          outcome?: Database["public"]["Enums"]["referral_outcome"] | null
          outcome_recorded_at?: string | null
          past_medical_history_enc?: string | null
          patient_initials?: string | null
          previous_referral_id?: string | null
          reason_category?:
            | Database["public"]["Enums"]["referral_reason_category"]
            | null
          reason_for_referral_enc?: string | null
          referral_received_at?: string
          referring_specialty?: string | null
          resus_status?: Database["public"]["Enums"]["resus_status"] | null
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
          updated_by?: string | null
          ward_review_timeframe?: string | null
          weight_kg?: number | null
        }
        Update: {
          accepting_consultant?: string | null
          admission_urgency?:
            | Database["public"]["Enums"]["admission_urgency"]
            | null
          age?: number | null
          allergies?: string | null
          anticipated_interventions?: string[]
          arrived_on_unit_at?: string | null
          baseline_function_enc?: string | null
          ceiling_of_care?:
            | Database["public"]["Enums"]["ceiling_of_care"]
            | null
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
          for_ongoing_ccot_review?: boolean
          frailty_score?: number | null
          hospital_number_enc?: string | null
          hospital_number_hash?: string | null
          id?: string
          infection_organism?: string | null
          infection_status?:
            | Database["public"]["Enums"]["infection_status"]
            | null
          is_test?: boolean
          needs_ward_review?: boolean
          news2_recorded_at?: string | null
          news2_score?: number | null
          origin_booking_id?: string | null
          outcome?: Database["public"]["Enums"]["referral_outcome"] | null
          outcome_recorded_at?: string | null
          past_medical_history_enc?: string | null
          patient_initials?: string | null
          previous_referral_id?: string | null
          reason_category?:
            | Database["public"]["Enums"]["referral_reason_category"]
            | null
          reason_for_referral_enc?: string | null
          referral_received_at?: string
          referring_specialty?: string | null
          resus_status?: Database["public"]["Enums"]["resus_status"] | null
          sex?: Database["public"]["Enums"]["patient_sex"] | null
          status?: Database["public"]["Enums"]["referral_status"]
          updated_at?: string
          updated_by?: string | null
          ward_review_timeframe?: string | null
          weight_kg?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "referrals_origin_booking_id_fkey"
            columns: ["origin_booking_id"]
            isOneToOne: false
            referencedRelation: "postop_bookings"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "referrals_previous_referral_id_fkey"
            columns: ["previous_referral_id"]
            isOneToOne: false
            referencedRelation: "referrals"
            referencedColumns: ["id"]
          },
        ]
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
      expire_stale_notifications: {
        Args: { _batch_limit?: number }
        Returns: number
      }
      finalize_auth_attempt: {
        Args: { _attempt_id: number; _success: boolean }
        Returns: undefined
      }
      get_bridge_cron_state: {
        Args: never
        Returns: {
          active: boolean
          jobname: string
          schedule: string
        }[]
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
      snapshot_patient_acuity: { Args: never; Returns: number }
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
      bridge_reconcile_item_status:
        | "pending"
        | "running"
        | "complete"
        | "error"
        | "locked"
        | "skipped"
      bridge_reconcile_job_status:
        | "queued"
        | "running"
        | "complete"
        | "failed"
        | "cancelled"
      ceiling_of_care:
        | "full_escalation"
        | "no_cpr"
        | "ward_based"
        | "symptom_control"
        | "not_documented"
      infection_status: "none" | "suspected" | "confirmed" | "unknown"
      patient_location: "icu" | "outlier"
      patient_sex: "male" | "female" | "other" | "unknown"
      patient_status: "referred" | "admitted" | "discharged" | "died"
      postop_booking_status:
        | "requested"
        | "provisionally_confirmed"
        | "confirmed"
        | "admitted"
        | "cancelled"
      postop_cancellation_reason:
        | "no_bed"
        | "patient_unfit"
        | "surgery_deferred"
        | "died_pre_op"
        | "other"
      postop_level: "level_1" | "level_2" | "level_3"
      referral_outcome:
        | "admit_for_admission"
        | "review_on_ward"
        | "advice_given"
        | "declined"
      referral_reason_category:
        | "respiratory_failure"
        | "sepsis"
        | "shock"
        | "post_op"
        | "neurology"
        | "trauma"
        | "gi_bleed"
        | "metabolic"
        | "overdose"
        | "other"
      referral_status: "pending" | "declined" | "admitted" | "accepted"
      resus_status: "for_cpr" | "dnacpr" | "not_documented"
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
      bridge_reconcile_item_status: [
        "pending",
        "running",
        "complete",
        "error",
        "locked",
        "skipped",
      ],
      bridge_reconcile_job_status: [
        "queued",
        "running",
        "complete",
        "failed",
        "cancelled",
      ],
      ceiling_of_care: [
        "full_escalation",
        "no_cpr",
        "ward_based",
        "symptom_control",
        "not_documented",
      ],
      infection_status: ["none", "suspected", "confirmed", "unknown"],
      patient_location: ["icu", "outlier"],
      patient_sex: ["male", "female", "other", "unknown"],
      patient_status: ["referred", "admitted", "discharged", "died"],
      postop_booking_status: [
        "requested",
        "provisionally_confirmed",
        "confirmed",
        "admitted",
        "cancelled",
      ],
      postop_cancellation_reason: [
        "no_bed",
        "patient_unfit",
        "surgery_deferred",
        "died_pre_op",
        "other",
      ],
      postop_level: ["level_1", "level_2", "level_3"],
      referral_outcome: [
        "admit_for_admission",
        "review_on_ward",
        "advice_given",
        "declined",
      ],
      referral_reason_category: [
        "respiratory_failure",
        "sepsis",
        "shock",
        "post_op",
        "neurology",
        "trauma",
        "gi_bleed",
        "metabolic",
        "overdose",
        "other",
      ],
      referral_status: ["pending", "declined", "admitted", "accepted"],
      resus_status: ["for_cpr", "dnacpr", "not_documented"],
    },
  },
} as const
