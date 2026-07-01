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
      profiles: {
        Row: {
          created_at: string
          full_name: string | null
          id: string
          is_at_work: boolean
          job_title: string | null
          notify_notes: boolean
          notify_status: boolean
          shift_updated_at: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          full_name?: string | null
          id: string
          is_at_work?: boolean
          job_title?: string | null
          notify_notes?: boolean
          notify_status?: boolean
          shift_updated_at?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          full_name?: string | null
          id?: string
          is_at_work?: boolean
          job_title?: string | null
          notify_notes?: boolean
          notify_status?: boolean
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
      referral_notes: {
        Row: {
          author_id: string
          body_enc: string | null
          created_at: string
          edited_at: string | null
          id: string
          referral_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          body_enc?: string | null
          created_at?: string
          edited_at?: string | null
          id?: string
          referral_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          body_enc?: string | null
          created_at?: string
          edited_at?: string | null
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
    }
    Enums: {
      admission_urgency:
        | "within_15_min"
        | "within_30_min"
        | "within_1_hour"
        | "within_1_2_hours"
        | "not_admitting"
      app_role: "admin" | "clinician"
      audit_action: "view" | "create" | "update" | "delete"
      patient_sex: "male" | "female" | "other" | "unknown"
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
      audit_action: ["view", "create", "update", "delete"],
      patient_sex: ["male", "female", "other", "unknown"],
      referral_status: ["pending", "declined", "admitted", "accepted"],
    },
  },
} as const
