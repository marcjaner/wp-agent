<?php
/**
 * Plugin Name: wp-agent Bridge
 * Description: Narrow authenticated WordPress capabilities for wp-agent.
 * Version: 0.1.0
 * Requires at least: 6.4
 * Requires PHP: 7.4
 * License: MIT
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'WP_AGENT_BRIDGE_VERSION', '0.1.0' );

function wp_agent_bridge_error( $code, $message, $status ) {
	return new WP_Error( $code, $message, array( 'status' => $status ) );
}

function wp_agent_bridge_can_edit_theme() {
	return current_user_can( 'edit_theme_options' );
}

function wp_agent_bridge_can_edit_css() {
	return current_user_can( 'edit_css' );
}

function wp_agent_bridge_discovery() {
	return array(
		'bridgeVersion' => WP_AGENT_BRIDGE_VERSION,
		'capabilities'  => array(
			'theme.customizerSettings.read',
			'theme.customizerSettings.write',
			'customCss.read',
			'customCss.write',
		),
	);
}

function wp_agent_bridge_customizer() {
	require_once ABSPATH . WPINC . '/class-wp-customize-manager.php';
	global $wp_customize;
	$wp_customize = new WP_Customize_Manager();
	do_action( 'customize_register', $wp_customize );
	return $wp_customize;
}

function wp_agent_bridge_setting( $manager, $id ) {
	if ( ! is_string( $id ) || ! preg_match( '/^[a-zA-Z0-9_-]+(?:\[[a-zA-Z0-9_-]+\])*$/', $id ) ) {
		return wp_agent_bridge_error( 'invalid_setting_id', 'Invalid Customizer setting ID.', 400 );
	}
	$setting = $manager->get_setting( $id );
	if ( ! $setting || ! in_array( $setting->type, array( 'option', 'theme_mod' ), true ) ) {
		return wp_agent_bridge_error( 'setting_not_available', 'Setting is not an available theme Customizer setting.', 404 );
	}
	if ( 'option' === $setting->type && false === strpos( $id, '[' ) ) {
		return wp_agent_bridge_error( 'setting_not_available', 'Root options are not exposed.', 404 );
	}
	if ( ! $setting->check_capabilities() ) {
		return wp_agent_bridge_error( 'setting_forbidden', 'Insufficient permission for this setting.', 403 );
	}
	return $setting;
}

function wp_agent_bridge_read_settings( $request ) {
	$ids = $request->get_param( 'ids' );
	if ( ! is_array( $ids ) || count( $ids ) < 1 || count( $ids ) > 30 ) {
		return wp_agent_bridge_error( 'invalid_settings', 'Provide 1 to 30 setting IDs.', 400 );
	}
	$manager = wp_agent_bridge_customizer();
	$values  = array();
	foreach ( $ids as $id ) {
		$setting = wp_agent_bridge_setting( $manager, $id );
		if ( is_wp_error( $setting ) ) {
			return $setting;
		}
		$values[ $id ] = $setting->value();
	}
	return array( 'stylesheet' => get_stylesheet(), 'settings' => $values );
}

function wp_agent_bridge_write_settings( $request ) {
	$values = $request->get_param( 'settings' );
	if ( ! is_array( $values ) || count( $values ) < 1 || count( $values ) > 30 || array_keys( $values ) === range( 0, count( $values ) - 1 ) ) {
		return wp_agent_bridge_error( 'invalid_settings', 'Provide 1 to 30 named settings.', 400 );
	}
	$manager = wp_agent_bridge_customizer();
	$checked = array();
	foreach ( $values as $id => $value ) {
		$setting = wp_agent_bridge_setting( $manager, $id );
		if ( is_wp_error( $setting ) ) {
			return $setting;
		}
		if ( ! is_scalar( $value ) ) {
			return wp_agent_bridge_error( 'invalid_setting_value', 'Setting values must be scalar.', 400 );
		}
		if ( 'custom_logo' === $id && current_theme_supports( 'custom-logo' ) ) {
			if ( ! ctype_digit( (string) $value ) || ( (int) $value > 0 && ! wp_attachment_is_image( (int) $value ) ) ) {
				return wp_agent_bridge_error( 'invalid_setting_value', 'Logo must be an image attachment ID or zero.', 400 );
			}
			add_filter( 'customize_sanitize_custom_logo', 'absint' );
		}
		if ( ! has_filter( "customize_sanitize_{$id}" ) ) {
			return wp_agent_bridge_error( 'setting_not_safe', 'Setting has no registered sanitizer.', 400 );
		}
		if ( is_string( $value ) && strlen( $value ) > 4096 ) {
			return wp_agent_bridge_error( 'invalid_setting_value', 'Setting value is too long.', 400 );
		}
		$valid = $setting->validate( $value );
		$clean = $setting->sanitize( $value );
		if ( is_wp_error( $valid ) || is_wp_error( $clean ) || null === $clean || ! is_scalar( $clean ) || (string) $clean !== (string) $value ) {
			return wp_agent_bridge_error( 'invalid_setting_value', 'A Customizer setting rejected its value.', 400 );
		}
		$checked[ $id ] = $setting;
	}
	foreach ( $values as $id => $value ) {
		$manager->set_post_value( $id, $value );
		if ( false === $checked[ $id ]->save() ) {
			return wp_agent_bridge_error( 'setting_save_failed', 'Customizer setting could not be saved.', 500 );
		}
	}
	$updated = array();
	foreach ( $checked as $id => $setting ) {
		$updated[ $id ] = $setting->value();
	}
	return array( 'stylesheet' => get_stylesheet(), 'settings' => $updated );
}

function wp_agent_bridge_read_css() {
	$post = wp_get_custom_css_post();
	$css  = $post ? $post->post_content : '';
	return array(
		'stylesheet' => get_stylesheet(),
		'css'        => $css,
		'hash'       => hash( 'sha256', $css ),
		'postId'     => $post ? $post->ID : null,
	);
}

function wp_agent_bridge_write_css( $request ) {
	$css      = $request->get_param( 'css' );
	$expected = $request->get_param( 'expectedHash' );
	if ( ! is_string( $css ) || strlen( $css ) > 200000 || false !== strpos( $css, "\0" ) || preg_match( '/<\/style/i', $css ) ) {
		return wp_agent_bridge_error( 'invalid_css', 'CSS must be a valid string of at most 200 KB.', 400 );
	}
	if ( ! is_string( $expected ) || ! preg_match( '/^[a-f0-9]{64}$/', $expected ) ) {
		return wp_agent_bridge_error( 'invalid_hash', 'A current CSS hash is required.', 400 );
	}
	$current = wp_agent_bridge_read_css();
	if ( ! hash_equals( $current['hash'], $expected ) ) {
		return wp_agent_bridge_error( 'css_conflict', 'Custom CSS changed since it was read.', 409 );
	}
	$result = wp_update_custom_css_post( $css );
	if ( is_wp_error( $result ) ) {
		return wp_agent_bridge_error( 'css_save_failed', 'WordPress could not save Custom CSS.', 500 );
	}
	return wp_agent_bridge_read_css();
}

add_action( 'rest_api_init', function () {
	register_rest_route( 'wp-agent/v1', '/manifest', array(
		'methods'             => 'GET',
		'callback'            => 'wp_agent_bridge_discovery',
		'permission_callback' => '__return_true',
	) );
	register_rest_route( 'wp-agent/v1', '/theme-settings', array(
		array(
			'methods'             => 'GET',
			'callback'            => 'wp_agent_bridge_read_settings',
			'permission_callback' => 'wp_agent_bridge_can_edit_theme',
		),
		array(
			'methods'             => 'POST',
			'callback'            => 'wp_agent_bridge_write_settings',
			'permission_callback' => 'wp_agent_bridge_can_edit_theme',
		),
	) );
	register_rest_route( 'wp-agent/v1', '/custom-css', array(
		array(
			'methods'             => 'GET',
			'callback'            => 'wp_agent_bridge_read_css',
			'permission_callback' => 'wp_agent_bridge_can_edit_css',
		),
		array(
			'methods'             => 'POST',
			'callback'            => 'wp_agent_bridge_write_css',
			'permission_callback' => 'wp_agent_bridge_can_edit_css',
		),
	) );
} );
